/*
 * Cloudflare Access sits in front of cal.jeryn.me and only lets the owner through. This
 * checks its work on every request instead of trusting that a header is present: the
 * Cf-Access-Jwt-Assertion token must be signed by the team's current keys, issued for
 * this application, unexpired, and name the owner. Anything missing, including this
 * Worker's own configuration, is a refusal. There are no sessions here at all.
 */

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const CERTS_PATH = "/cdn-cgi/access/certs";
const CERTS_CACHE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

interface AccessConfig {
  audience?: string;
  ownerEmail?: string;
  teamDomain?: string;
}

interface AccessIdentity {
  email: string;
}

interface JsonWebKeySet {
  keys: (JsonWebKey & { kid?: string })[];
}

interface CachedCerts {
  fetchedAt: number;
  keys: Map<string, JsonWebKey>;
}

const certsByTeam = new Map<string, CachedCerts>();

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

const decodeSegment = (segment: string): Uint8Array => {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
};

const decodeJson = (segment: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const loadCerts = async (teamDomain: string, forceRefresh: boolean): Promise<Map<string, JsonWebKey>> => {
  const cached = certsByTeam.get(teamDomain);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < CERTS_CACHE_MS) {
    return cached.keys;
  }
  const response = await fetch(`${teamDomain}${CERTS_PATH}`);
  if (!response.ok) {
    throw new Error(`Access certs request failed with ${response.status}`);
  }
  const body = await response.json<JsonWebKeySet>();
  const keys = new Map<string, JsonWebKey>();
  for (const key of body.keys) {
    if (key.kid) {
      keys.set(key.kid, key);
    }
  }
  certsByTeam.set(teamDomain, { fetchedAt: Date.now(), keys });
  return keys;
};

const findKey = async (teamDomain: string, kid: string): Promise<JsonWebKey | null> => {
  const key = (await loadCerts(teamDomain, false)).get(kid);
  if (key) {
    return key;
  }
  // Access rotates keys; an unknown kid is worth exactly one fresh fetch.
  return (await loadCerts(teamDomain, true)).get(kid) ?? null;
};

const verifySignature = async (jwk: JsonWebKey, signedPart: string, signature: string): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeSegment(signature),
    new TextEncoder().encode(signedPart),
  );
};

const includesAudience = (claim: unknown, audience: string): boolean => {
  if (typeof claim === "string") {
    return claim === audience;
  }
  return Array.isArray(claim) && claim.includes(audience);
};

const hasValidTimes = (claims: Record<string, unknown>): boolean => {
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= now) {
    return false;
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    return false;
  }
  return true;
};

const verifyAccessToken = async (token: string, config: AccessConfig): Promise<AccessIdentity | null> => {
  const { audience, ownerEmail, teamDomain } = config;
  if (!audience || !ownerEmail || !teamDomain) {
    return null;
  }
  const team = normalizeOrigin(teamDomain);
  const segments = token.split(".");
  const [encodedHeader, encodedClaims, signature] = segments;
  if (segments.length !== 3 || !encodedHeader || !encodedClaims || !signature) {
    return null;
  }
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedClaims);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") {
    return null;
  }
  if (
    claims.iss !== team
    || !includesAudience(claims.aud, audience)
    || !hasValidTimes(claims)
    || typeof claims.email !== "string"
    || claims.email.toLowerCase() !== ownerEmail.toLowerCase()
  ) {
    return null;
  }
  const jwk = await findKey(team, header.kid);
  if (!jwk || !await verifySignature(jwk, `${encodedHeader}.${encodedClaims}`, signature)) {
    return null;
  }
  return { email: claims.email };
};

const authenticateRequest = async (request: Request, config: AccessConfig): Promise<AccessIdentity | null> => {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) {
    return null;
  }
  try {
    return await verifyAccessToken(token, config);
  } catch {
    // Unreachable certs, malformed keys: refuse rather than guess.
    return null;
  }
};

// One response for every refusal, so nothing distinguishes which check failed.
const forbidden = (): Response =>
  new Response("Forbidden", { headers: { "cache-control": "no-store" }, status: 403 });

const resetAccessCertsCache = (): void => {
  certsByTeam.clear();
};

export { authenticateRequest, forbidden, resetAccessCertsCache };
export type { AccessConfig, AccessIdentity };
