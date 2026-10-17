import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetAccessCertsCache } from "../src/http/access";

const TEAM = "https://jeryn.cloudflareaccess.com";
const AUD = "test-application-audience";
const OWNER = "jeryn@example.com";
const ORIGIN = "https://cal.jeryn.me";

const accessEnv = { ...env, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, OWNER_EMAIL: OWNER };

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const encodeJson = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

interface Signer {
  jwk: JsonWebKey & { kid: string };
  privateKey: CryptoKey;
}

const createSigner = async (kid: string): Promise<Signer> => {
  const pair = await crypto.subtle.generateKey(
    { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  return { jwk: { ...jwk, alg: "RS256", kid }, privateKey: pair.privateKey };
};

const now = (): number => Math.floor(Date.now() / 1000);

const validClaims = () => ({
  aud: [AUD],
  email: OWNER,
  exp: now() + 600,
  iat: now(),
  iss: TEAM,
  nbf: now() - 5,
  sub: "owner",
  type: "app",
});

const sign = async (signer: Signer, claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
  const head = encodeJson({ alg: "RS256", kid: signer.jwk.kid, typ: "JWT", ...header });
  const body = encodeJson(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
};

let trusted: Signer;
let attacker: Signer;
let publishedKeys: (JsonWebKey & { kid: string })[] = [];

beforeAll(async () => {
  trusted = await createSigner("key-1");
  attacker = await createSigner("key-1");
});

const serveCerts = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) {
      return Promise.resolve(Response.json({ keys: publishedKeys }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });

const call = (token: string | null, init: RequestInit = {}, workerEnv = accessEnv) => {
  const headers = new Headers(init.headers);
  if (token !== null) {
    headers.set("cf-access-jwt-assertion", token);
  }
  return worker.fetch?.(
    new Request(`${ORIGIN}/`, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>,
    workerEnv,
    createExecutionContext(),
  ) as Promise<Response>;
};

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessCertsCache();
});

describe("Cloudflare Access verification", () => {
  it("serves the page for the owner's genuine Access token", async () => {
    publishedKeys = [trusted.jwk];
    serveCerts();

    const response = await call(await sign(trusted, validClaims()));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<title>Keeper</title>");
    expect(body).toContain('<div id="root"></div>');
  });

  it.each([
    ["no Access header at all", async () => null],
    ["a token that is not a JWT", async () => "not-a-jwt"],
    ["a token signed by someone else's key under the right kid", async () => sign(attacker, validClaims())],
    ["an unsigned alg:none token", async () => {
      const token = await sign(trusted, validClaims());
      const [, body] = token.split(".");
      return `${encodeJson({ alg: "none", kid: "key-1" })}.${body}.`;
    }],
    ["a token with its claims edited after signing", async () => {
      const token = await sign(trusted, { ...validClaims(), email: "attacker@example.com" });
      const [head, , signature] = token.split(".");
      return `${head}.${encodeJson(validClaims())}.${signature}`;
    }],
    ["a token for another Access application", async () => sign(trusted, { ...validClaims(), aud: ["other-app"] })],
    ["a token from another team", async () => sign(trusted, { ...validClaims(), iss: "https://evil.cloudflareaccess.com" })],
    ["an expired token", async () => sign(trusted, { ...validClaims(), exp: now() - 3600 })],
    ["a token not valid yet", async () => sign(trusted, { ...validClaims(), nbf: now() + 3600 })],
    ["a genuine token for someone other than the owner", async () => sign(trusted, { ...validClaims(), email: "someone@example.com" })],
    ["a token naming a key the team never published", async () => sign(trusted, validClaims(), { kid: "unknown" })],
  ])("refuses %s with a plain 403", async (_label, makeToken) => {
    publishedKeys = [trusted.jwk];
    serveCerts();

    const response = await call(await makeToken());

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("refuses everything when the Worker's own Access settings are missing", async () => {
    publishedKeys = [trusted.jwk];
    serveCerts();
    const token = await sign(trusted, validClaims());

    for (const missing of ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "OWNER_EMAIL"] as const) {
      const response = await call(token, {}, { ...accessEnv, [missing]: "" });
      expect(response.status).toBe(403);
    }
  });

  it("refuses when the team's certificates cannot be fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));

    const response = await call(await sign(trusted, validClaims()));

    expect(response.status).toBe(403);
  });

  it("guards every route, including the OAuth callback and form posts", async () => {
    publishedKeys = [trusted.jwk];
    serveCerts();
    for (const path of ["/api/sources/callback/google?code=x&state=y", "/connect/google", "/missing"]) {
      const response = await worker.fetch?.(
        new Request(`${ORIGIN}${path}`) as Request<unknown, IncomingRequestCfProperties>,
        accessEnv,
        createExecutionContext(),
      ) as Response;
      expect(response.status).toBe(403);
    }
    const post = await call(null, { body: new URLSearchParams({ url: "https://x" }), headers: { origin: ORIGIN }, method: "POST" });
    expect(post.status).toBe(403);
  });

  it("accepts a rotated key after one fresh fetch of the certificates", async () => {
    const rotated = await createSigner("key-2");
    publishedKeys = [trusted.jwk];
    const fetchSpy = serveCerts();
    expect((await call(await sign(trusted, validClaims()))).status).toBe(200);

    publishedKeys = [trusted.jwk, rotated.jwk];
    const response = await call(await sign(rotated, validClaims()));

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("lets the owner read and change data through the API, but only from this site", async () => {
    publishedKeys = [trusted.jwk];
    serveCerts();
    const token = await sign(trusted, validClaims());
    const api = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", token);
      return worker.fetch?.(
        new Request(`${ORIGIN}${path}`, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>,
        { ...accessEnv, SYNC_QUEUE: { sendBatch: () => Promise.resolve() } as unknown as Queue<never> },
        createExecutionContext(),
      ) as Promise<Response>;
    };

    const accounts = await api("/api/accounts");
    expect(accounts.status).toBe(200);
    expect(Array.isArray(await accounts.json())).toBe(true);

    const save = (origin: string | null) => api("/api/sources/missing/destinations", {
      body: JSON.stringify({ calendarIds: [] }),
      headers: { "content-type": "application/json", ...(origin && { origin }) },
      method: "PUT",
    });
    expect((await save("https://evil.example")).status).toBe(403);
    expect((await save(null)).status).toBe(403);
    // Same origin reaches the API, which then reports the calendar does not exist.
    expect((await save(ORIGIN)).status).toBe(404);
  });
});
