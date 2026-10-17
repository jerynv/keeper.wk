import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { createDatabase, createSecretCodec } from "@keeper.sh/database";
import { calendarAccountsTable, calendarsTable, oauthCredentialsTable } from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetAccessCertsCache } from "../src/http/access";

const TEAM = "https://jeryn.cloudflareaccess.com";
const AUD = "test-application-audience";
const OWNER = "jeryn@example.com";
const ORIGIN = "https://cal.jeryn.me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

const database = createDatabase(env.DB);
const codec = createSecretCodec(env.ENCRYPTION_KEY);
const testEnv = {
  ...env,
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  OWNER_EMAIL: OWNER,
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encodeJson = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

let jwk: JsonWebKey = { kty: "RSA" };
let token = "";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey, alg: "RS256", kid: "k" } as JsonWebKey;
  const now = Math.floor(Date.now() / 1000);
  const head = encodeJson({ alg: "RS256", kid: "k", typ: "JWT" });
  const body = encodeJson({ aud: [AUD], email: OWNER, exp: now + 600, iss: TEAM, nbf: now - 5 });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  token = `${head}.${body}.${base64url(new Uint8Array(signature))}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessCertsCache();
});

const refresh = async (accountId: string) => {
  const response = await worker.fetch?.(
    new Request(`${ORIGIN}/api/accounts/${accountId}/refresh`, {
      headers: { "cf-access-jwt-assertion": token, origin: ORIGIN },
      method: "POST",
    }) as Request<unknown, IncomingRequestCfProperties>,
    testEnv,
    createExecutionContext(),
  ) as Response;
  return response;
};

const seedGoogleAccount = async (expiresAt: Date) => {
  const [credential] = await database.insert(oauthCredentialsTable).values({
    accessToken: codec.seal("stale-access"),
    expiresAt,
    provider: "google",
    refreshToken: codec.seal("refresh-1"),
  }).returning({ id: oauthCredentialsTable.id });
  const [account] = await database.insert(calendarAccountsTable).values({
    accountId: `google-${crypto.randomUUID()}`,
    authType: "oauth",
    oauthCredentialId: credential?.id ?? null,
    provider: "google",
  }).returning({ id: calendarAccountsTable.id });
  return { accountId: account?.id ?? "", credentialId: credential?.id ?? "" };
};

describe("refreshing one account's calendars", () => {
  it("renews an expired Google token, then reports imported / missing / restored", async () => {
    const { accountId, credentialId } = await seedGoogleAccount(new Date(Date.now() - 60_000));
    const seenTokens: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${TEAM}/cdn-cgi/access/certs`) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (url === TOKEN_URL) {
        return Promise.resolve(Response.json({ access_token: "fresh-access", expires_in: 3600, scope: "calendar", token_type: "Bearer" }));
      }
      if (url.startsWith(LIST_URL)) {
        seenTokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return Promise.resolve(Response.json({
          items: [{ accessRole: "owner", id: "primary@example.com", summary: "Primary" }],
          kind: "calendar#calendarList",
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    const response = await refresh(accountId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imported: 1, missing: 0, restored: 0 });
    expect(seenTokens).toEqual(["Bearer fresh-access"]);
    const [stored] = await database.select().from(oauthCredentialsTable).where(eq(oauthCredentialsTable.id, credentialId));
    expect(codec.open(stored?.accessToken ?? "")).toBe("fresh-access");
    const calendars = await database.select().from(calendarsTable).where(eq(calendarsTable.accountId, accountId));
    expect(calendars).toHaveLength(1);
  });

  it("reports nothing changed for a feed, and 404 for an unknown account", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ keys: [jwk] })));
    const [feed] = await database.insert(calendarAccountsTable).values({ authType: "none", provider: "ics" })
      .returning({ id: calendarAccountsTable.id });

    const feedResponse = await refresh(feed?.id ?? "");
    expect(await feedResponse.json()).toEqual({ imported: 0, missing: 0, restored: 0 });
    expect((await refresh("missing-account")).status).toBe(404);
  });
});
