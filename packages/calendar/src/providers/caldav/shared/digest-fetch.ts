import { createDigestClient, selectChallenge } from "@keeper.sh/digest-fetch";
import { recordRequest } from "./response-status-scope";
import { encodeBase64 } from "../../../core/utils/base64";

type FetchFunction = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

type AuthMethod = "unknown" | "basic" | "digest";

const HTTP_UNAUTHORIZED = 401;

interface DigestFetchCredentials {
  username: string;
  password: string;
}

const encodeBasicCredentials = (username: string, password: string): string => {
  const encoded = encodeBase64(`${username}:${password}`);
  return `Basic ${encoded}`;
};

const mergeHeaders = (
  init: RequestInit | undefined,
  extra: Record<string, string>,
): Record<string, string> => {
  const merged: Record<string, string> = {};
  const existing = new Headers(init?.headers);
  for (const [key, value] of existing.entries()) {
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    merged[key] = value;
  }
  return merged;
};

const offersScheme = (response: Response, scheme: string): boolean =>
  selectChallenge(response.headers.get("www-authenticate"), scheme) !== null;

interface DigestAwareFetchOptions {
  credentials: DigestFetchCredentials;
  baseFetch: FetchFunction;
  knownAuthMethod?: "basic" | "digest";
}

interface DigestAwareFetchResult {
  fetch: FetchFunction;
  getResolvedMethod: () => CalDAVAuthMethod | null;
}

const createDigestAwareFetch = (options: DigestAwareFetchOptions): DigestAwareFetchResult => {
  const { credentials, baseFetch, knownAuthMethod } = options;
  const basicAuth = encodeBasicCredentials(credentials.username, credentials.password);
  const digestClient = createDigestClient({
    user: credentials.username,
    password: credentials.password,
    fetch: baseFetch,
  });

  const state: { method: AuthMethod } = {
    method: knownAuthMethod ?? "unknown",
  };

  const basicFetch: FetchFunction = (input, init) =>
    baseFetch(input, { ...init, headers: mergeHeaders(init, { authorization: basicAuth }) });

  const fetchWithDigest: FetchFunction = async (input, init) => {
    const response = await digestClient.fetch(input, init);

    if (response.status !== HTTP_UNAUTHORIZED) {
      return response;
    }

    if (offersScheme(response, "Digest") || !offersScheme(response, "Basic")) {
      return response;
    }

    await response.body?.cancel();
    state.method = "basic";
    return basicFetch(input, init);
  };

  const authenticatedFetch: FetchFunction = async (input, init) => {
    if (state.method === "digest") {
      return fetchWithDigest(input, init);
    }

    const response = await basicFetch(input, init);

    if (response.status !== HTTP_UNAUTHORIZED) {
      if (response.ok) {
        state.method = "basic";
      }
      return response;
    }

    if (!offersScheme(response, "Digest")) {
      return response;
    }

    await response.body?.cancel();
    state.method = "digest";
    return digestClient.fetch(input, init);
  };

  const performFetch: FetchFunction = (input, init) =>
    recordRequest(async () => {
      const response = await authenticatedFetch(input, init);
      if (response.status === HTTP_UNAUTHORIZED) {
        // Only what the server said back, never the request's own headers.
        const url = new URL(input instanceof Request ? input.url : input.toString());
        console.warn(`caldav 401: ${init?.method ?? "GET"} ${url.host} via ${state.method}; ${JSON.stringify(Object.fromEntries(response.headers))}`);
      }
      return response;
    });

  const getResolvedMethod = (): CalDAVAuthMethod | null => {
    if (state.method === "unknown") {
      return null;
    }
    return state.method;
  };

  return { fetch: performFetch, getResolvedMethod };
};

type CalDAVAuthMethod = "basic" | "digest";

const resolveAuthMethod = (value: string): CalDAVAuthMethod => {
  if (value === "digest") {
    return "digest";
  }
  return "basic";
};

export { createDigestAwareFetch, resolveAuthMethod };
export type { CalDAVAuthMethod };
