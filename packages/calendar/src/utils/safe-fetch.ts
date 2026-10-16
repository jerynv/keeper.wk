import ipaddr from "ipaddr.js";
import { getDomain } from "tldts";
import { RequestTimeoutError, buildTimeoutSignal } from "../core/utils/fetch-with-timeout";
import type { TimeoutSignal } from "../core/utils/fetch-with-timeout";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 10;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SITE_BOUNDARY_OPTIONS = { allowPrivateDomains: true };

interface SafeFetchOptions {
  blockPrivateResolution?: boolean;
  allowedPrivateHosts?: Set<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class UrlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

type SafeFetch = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

const GLOBAL_UNICAST_IPV6 = ipaddr.parseCIDR("2000::/3");
const IPV6_DOCUMENTATION = ipaddr.parseCIDR("3fff::/20");

const normalizeToIPv4 = (parsed: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 => {
  if (parsed.kind() === "ipv6" && "isIPv4MappedAddress" in parsed && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address();
  }
  return parsed;
};

const isGloballyRoutableAddress = (address: string): boolean => {
  try {
    const parsed = normalizeToIPv4(ipaddr.parse(address));
    if (parsed.kind() === "ipv4") {
      return parsed.range() === "unicast";
    }
    if (parsed.range() !== "unicast" || parsed.match(IPV6_DOCUMENTATION)) {
      return false;
    }
    return parsed.match(GLOBAL_UNICAST_IPV6);
  } catch {
    return false;
  }
};

const assertGloballyRoutableAddress = (address: string, message: string): void => {
  if (!isGloballyRoutableAddress(address)) {
    throw new UrlSafetyError(message);
  }
};

const stripBrackets = (hostname: string): string => hostname.replace(/^\[/, "").replace(/\]$/, "");

const validateProtocol = (protocol: string): void => {
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    throw new UrlSafetyError(
      `URL scheme "${protocol.replace(":", "")}" is not allowed. Only HTTP and HTTPS are supported.`,
    );
  }
};

/*
 * Upstream resolved the hostname and pinned the connection to the vetted address, using
 * Bun's non-standard tls option. Workers cannot pin, and do not need to: Cloudflare
 * refuses to connect a Worker to a hostname that resolves to a private or reserved
 * address (error 1000), so only literal addresses are checked here.
 */
const assertUrlAllowed = (url: string, options?: SafeFetchOptions): void => {
  const parsed = new URL(url);
  validateProtocol(parsed.protocol);

  if (!options?.blockPrivateResolution || options.allowedPrivateHosts?.has(parsed.host)) {
    return;
  }

  const hostname = stripBrackets(parsed.hostname);
  if (ipaddr.isValid(hostname)) {
    assertGloballyRoutableAddress(hostname, "The provided URL points to a private or reserved network address.");
  }
};

// A refusal arrives as a rejection, which is what callers await.
const validateUrlSafety = (url: string, options?: SafeFetchOptions): Promise<void> =>
  new Promise((resolve) => {
    assertUrlAllowed(url, options);
    resolve();
  });

const resolveRedirectUrl = (response: Response, originalUrl: string): string | null => {
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }

  try {
    return new URL(location, originalUrl).href;
  } catch {
    return null;
  }
};

const isTransportDowngrade = (current: URL, next: URL): boolean =>
  current.protocol === "https:" && next.protocol !== "https:";

const isDifferentSite = (current: URL, next: URL): boolean => {
  const currentDomain = getDomain(current.hostname, SITE_BOUNDARY_OPTIONS);
  const nextDomain = getDomain(next.hostname, SITE_BOUNDARY_OPTIONS);
  if (!currentDomain || !nextDomain) {
    return current.hostname !== next.hostname;
  }
  return currentDomain !== nextDomain;
};

const shouldWithholdAuthorization = (current: string, next: string): boolean => {
  const currentUrl = new URL(current);
  const nextUrl = new URL(next);
  return isTransportDowngrade(currentUrl, nextUrl) || isDifferentSite(currentUrl, nextUrl);
};

const toHeaderRecord = (headers: RequestInit["headers"]): Record<string, string> => {
  const normalized = new Headers(headers);
  const record: Record<string, string> = {};

  for (const [key, value] of normalized.entries()) {
    record[key] = value;
  }

  return record;
};

const mergeHeaderRecord = (input: string | Request | URL, init: RequestInit | undefined): Record<string, string> => {
  const merged = new Headers();

  if (input instanceof Request) {
    for (const [key, value] of input.headers.entries()) {
      merged.set(key, value);
    }
  }

  for (const [key, value] of new Headers(init?.headers).entries()) {
    merged.set(key, value);
  }

  return toHeaderRecord(merged);
};

const withoutAuthorization = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization"));

const isRedirect = (response: Response): boolean => REDIRECT_STATUS_CODES.has(response.status);

const getHeadersForRedirect = (
  headers: Record<string, string>,
  currentUrl: string,
  redirectUrl: string,
): Record<string, string> => {
  if (shouldWithholdAuthorization(currentUrl, redirectUrl)) {
    return withoutAuthorization(headers);
  }
  return headers;
};

/*
 * A caller that follows the redirect itself takes the target as its new base URL and
 * authenticates against it later, so a boundary-crossing hop leaks the credentials even
 * when this request carried none: digest authentication sends its first request
 * unauthenticated and only answers the challenge the target issues.
 */
const assertManualRedirectKeepsCredentials = (currentUrl: string, response: Response): void => {
  const redirectUrl = resolveRedirectUrl(response, currentUrl);
  if (!redirectUrl || !shouldWithholdAuthorization(currentUrl, redirectUrl)) {
    return;
  }

  throw new UrlSafetyError(
    `Redirect to ${redirectUrl} crosses a credential boundary and the caller follows redirects itself, so the credentials cannot be withheld from it.`,
  );
};

const WITHHELD_CREDENTIALS = Symbol.for("keeper.sh/safe-fetch/withheld-credentials");

interface WithheldCredentials {
  redirectedTo: string;
}

const markWithheldCredentials = (response: Response, redirectedTo: string): Response => {
  Object.defineProperty(response, WITHHELD_CREDENTIALS, {
    configurable: true,
    enumerable: false,
    value: { redirectedTo },
    writable: false,
  });
  return response;
};

const getWithheldCredentials = (response: Response): WithheldCredentials | null =>
  (Reflect.get(response, WITHHELD_CREDENTIALS) as WithheldCredentials | undefined) ?? null;

const performFetch = (
  input: string | Request | URL,
  init: RequestInit,
  headers: Record<string, string>,
): Promise<Response> => globalThis.fetch(input, { ...init, headers });

const followRedirects = async (
  initialUrl: string,
  initialResponse: Response,
  init: RequestInit | undefined,
  headers: Record<string, string>,
  options: SafeFetchOptions | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> => {
  let currentUrl = initialUrl;
  let currentResponse = initialResponse;
  let currentHeaders = headers;
  let withheldAt: string | null = null;

  const settle = (response: Response): Response => {
    if (!withheldAt) {
      return response;
    }
    return markWithheldCredentials(response, withheldAt);
  };

  for (let count = 0; count < MAX_REDIRECTS; count++) {
    const redirectUrl = resolveRedirectUrl(currentResponse, currentUrl);
    if (!redirectUrl) {
      return settle(currentResponse);
    }

    assertUrlAllowed(redirectUrl, options);

    const nextHeaders = getHeadersForRedirect(currentHeaders, currentUrl, redirectUrl);
    if (!withheldAt && currentHeaders.authorization && !nextHeaders.authorization) {
      withheldAt = redirectUrl;
    }
    currentHeaders = nextHeaders;
    currentUrl = redirectUrl;

    currentResponse = await performFetch(
      currentUrl,
      { ...init, redirect: "manual", signal },
      currentHeaders,
    );

    if (!isRedirect(currentResponse)) {
      return settle(currentResponse);
    }
  }

  throw new UrlSafetyError(`Too many redirects (exceeded ${MAX_REDIRECTS}).`);
};

const extractUrl = (input: string | Request | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
};

const resolveTimeoutSignal = (
  options: SafeFetchOptions | undefined,
  externalSignal: AbortSignal | null | undefined,
): TimeoutSignal | null => {
  if (!options?.timeoutMs) {
    return null;
  }
  return buildTimeoutSignal(options.timeoutMs, externalSignal);
};

const resolveRequestSignal = (
  timeout: TimeoutSignal | null,
  externalSignal: AbortSignal | null | undefined,
): AbortSignal | null | undefined => timeout?.signal ?? externalSignal;

const resolveExternalSignal = (
  input: string | Request | URL,
  init: RequestInit | undefined,
  options: SafeFetchOptions | undefined,
): AbortSignal | null => {
  const signals: AbortSignal[] = [];
  if (options?.signal) {
    signals.push(options.signal);
  }
  if (init?.signal) {
    signals.push(init.signal);
  }
  if (input instanceof Request) {
    signals.push(input.signal);
  }
  const uniqueSignals = [...new Set(signals)];

  if (uniqueSignals.length === 0) {
    return null;
  }
  if (uniqueSignals.length === 1) {
    return uniqueSignals.at(0) ?? null;
  }
  return AbortSignal.any(uniqueSignals);
};

const createSafeFetch = (options?: SafeFetchOptions): SafeFetch => async (input, init) => {
    const url = extractUrl(input);
    assertUrlAllowed(url, options);

    const callerWantsManual = init?.redirect === "manual";

    const externalSignal = resolveExternalSignal(input, init, options);
    const timeout = resolveTimeoutSignal(options, externalSignal);
    const signal = resolveRequestSignal(timeout, externalSignal);
    const headers = mergeHeaderRecord(input, init);

    try {
      const response = await performFetch(input, { ...init, redirect: "manual", signal }, headers);

      if (!isRedirect(response)) {
        return response;
      }

      if (callerWantsManual) {
        assertManualRedirectKeepsCredentials(url, response);
        return response;
      }

      return await followRedirects(url, response, init, headers, options, signal);
    } catch (error) {
      if (timeout?.isTimeout() && options?.timeoutMs) {
        throw new RequestTimeoutError(options.timeoutMs);
      }
      throw error;
    }
  };

export { createSafeFetch, getWithheldCredentials, UrlSafetyError, validateUrlSafety };
export type { SafeFetchOptions, WithheldCredentials };
