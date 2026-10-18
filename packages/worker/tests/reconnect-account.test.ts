import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { createDatabase, createSecretCodec } from "@keeper.sh/database";
import { caldavCredentialsTable, calendarAccountsTable, calendarsTable } from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetAccessCertsCache } from "../src/http/access";

const TEAM = "https://jeryn.cloudflareaccess.com";
const AUD = "test-application-audience";
const OWNER = "jeryn@example.com";
const ORIGIN = "https://cal.jeryn.me";

const database = createDatabase(env.DB);
const testEnv = { ...env, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, OWNER_EMAIL: OWNER };

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

const multistatus = (href: string, prop: string): Response =>
  new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { headers: { "content-type": "application/xml; charset=utf-8" }, status: 207 },
  );

const davResponse = (url: string, body: string): Response => {
  const path = new URL(url).pathname;
  if (body.includes("current-user-principal")) {
    return multistatus(path, "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>");
  }
  if (body.includes("calendar-home-set")) {
    return multistatus(path, "<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>");
  }
  return multistatus(path, "<d:resourcetype><d:collection/></d:resourcetype>");
};

describe("reconnecting a CalDAV account", () => {
  it("clears the reconnect flag and both backoff clocks on its calendars", async () => {
    const later = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const [credential] = await database.insert(caldavCredentialsTable).values({
      encryptedPassword: createSecretCodec(env.ENCRYPTION_KEY).seal("old"),
      serverUrl: "https://caldav.icloud.com",
      username: "jeryn@icloud.com",
    }).returning({ id: caldavCredentialsTable.id });
    const [account] = await database.insert(calendarAccountsTable).values({
      authType: "caldav",
      caldavCredentialId: credential?.id ?? null,
      needsReauthentication: true,
      provider: "icloud",
    }).returning({ id: calendarAccountsTable.id });
    const accountId = account?.id ?? "";
    await database.insert(calendarsTable).values({
      accountId,
      calendarType: "caldav",
      failureCount: 7,
      ingestFailureCount: 3,
      ingestLastFailureAt: new Date(),
      ingestNextAttemptAt: later,
      lastFailureAt: new Date(),
      name: "Work",
      nextAttemptAt: later,
    });
    // Access's keys, then a CalDAV server that accepts the new password and has no calendars.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      let url = String(input);
      if (input instanceof Request) {
        ({ url } = input);
      }
      if (url.startsWith(TEAM)) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      return Promise.resolve(davResponse(url, String(init?.body ?? "")));
    });

    const response = await worker.fetch?.(
      new Request(`${ORIGIN}/api/accounts/${accountId}/reconnect`, {
        body: JSON.stringify({ password: "new-app-password" }),
        headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", origin: ORIGIN },
        method: "POST",
      }) as Request<unknown, IncomingRequestCfProperties>,
      testEnv,
      createExecutionContext(),
    ) as Response;

    expect(response.status).toBe(200);
    const [stored] = await database.select().from(calendarAccountsTable).where(eq(calendarAccountsTable.id, accountId));
    expect(stored?.needsReauthentication).toBe(false);
    const [calendar] = await database.select().from(calendarsTable).where(eq(calendarsTable.accountId, accountId));
    expect(calendar).toMatchObject({
      failureCount: 0,
      ingestFailureCount: 0,
      ingestLastFailureAt: null,
      ingestNextAttemptAt: null,
      lastFailureAt: null,
      nextAttemptAt: null,
    });
  });
});
