import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateUrlSafety, createSafeFetch, UrlSafetyError } from "../../src/utils/safe-fetch";
import type { SafeFetchOptions } from "../../src/utils/safe-fetch";

const { mockResolve4, mockResolve6 } = vi.hoisted(() => ({
  mockResolve4: vi.fn<(hostname: string) => Promise<string[]>>(),
  mockResolve6: vi.fn<(hostname: string) => Promise<string[]>>(),
}));

vi.mock("node:dns/promises", () => ({
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

const enabledOptions: SafeFetchOptions = { blockPrivateResolution: true };

beforeEach(() => {
  mockResolve4.mockReset();
  mockResolve6.mockReset();

  mockResolve6.mockRejectedValue(new Error("no AAAA records"));
});

describe("validateUrlSafety", () => {
  describe("scheme validation (always enforced)", () => {
    it("rejects file:// URLs", async () => {
      await expect(validateUrlSafety("file:///etc/passwd")).rejects.toThrow(UrlSafetyError);
    });

    it("rejects ftp:// URLs", async () => {
      await expect(validateUrlSafety("ftp://server/file")).rejects.toThrow(UrlSafetyError);
    });

    it("rejects data: URLs", async () => {
      await expect(validateUrlSafety("data:text/html,<h1>test</h1>")).rejects.toThrow(UrlSafetyError);
    });

    it("rejects non-http schemes even without blockPrivateResolution", async () => {
      await expect(validateUrlSafety("file:///etc/passwd", {})).rejects.toThrow(UrlSafetyError);
    });
  });

  describe("when blockPrivateResolution is true", () => {
    it("allows http:// URLs with public IPs", async () => {
      mockResolve4.mockResolvedValue(["93.184.216.34"]);
      await expect(validateUrlSafety("http://example.com/cal.ics", enabledOptions)).resolves.toBeUndefined();
    });

    it("allows https:// URLs with public IPs", async () => {
      mockResolve4.mockResolvedValue(["93.184.216.34"]);
      await expect(validateUrlSafety("https://example.com/cal.ics", enabledOptions)).resolves.toBeUndefined();
    });

    it("rejects loopback IPv4", async () => {
      await expect(validateUrlSafety("http://127.0.0.1/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects loopback IPv6", async () => {
      await expect(validateUrlSafety("http://[::1]/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects private 10.x.x.x", async () => {
      await expect(validateUrlSafety("http://10.0.0.1/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects private 172.16.x.x", async () => {
      await expect(validateUrlSafety("http://172.16.0.1/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects private 192.168.x.x", async () => {
      await expect(validateUrlSafety("http://192.168.1.1/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects link-local 169.254.x.x (AWS metadata)", async () => {
      await expect(validateUrlSafety("http://169.254.169.254/latest/meta-data/", enabledOptions)).rejects.toThrow(
        UrlSafetyError,
      );
    });

    it("rejects an IPv4-mapped IPv6 loopback literal", async () => {
      await expect(validateUrlSafety("http://[::ffff:127.0.0.1]/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("rejects 0.0.0.0", async () => {
      await expect(validateUrlSafety("http://0.0.0.0/", enabledOptions)).rejects.toThrow(UrlSafetyError);
    });

    it("allows public IP literals", async () => {
      await expect(validateUrlSafety("http://93.184.216.34/cal.ics", enabledOptions)).resolves.toBeUndefined();
    });

    it("allows hostnames resolving to public IPs", async () => {
      mockResolve4.mockResolvedValue(["93.184.216.34"]);
      await expect(validateUrlSafety("https://calendar.google.com/basic.ics", enabledOptions)).resolves.toBeUndefined();
    });

  });

  describe("allowedPrivateHosts", () => {
    it("allows a private IP with port when host:port is in the whitelist", async () => {
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["192.168.1.50:5232"]) };
      await expect(validateUrlSafety("http://192.168.1.50:5232/", options)).resolves.toBeUndefined();
    });

    it("allows a private IP on default port when hostname is in the whitelist", async () => {
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["192.168.1.50"]) };
      await expect(validateUrlSafety("http://192.168.1.50/", options)).resolves.toBeUndefined();
    });

    it("allows a private hostname with port when host:port is in the whitelist", async () => {
      mockResolve4.mockResolvedValue(["10.0.0.5"]);
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["radicale.local:5232"]) };
      await expect(validateUrlSafety("http://radicale.local:5232/", options)).resolves.toBeUndefined();
    });

    it("rejects when port differs from whitelist entry", async () => {
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["192.168.1.50:5232"]) };
      await expect(validateUrlSafety("http://192.168.1.50:9999/", options)).rejects.toThrow(UrlSafetyError);
    });

    it("still rejects private IPs not in the whitelist", async () => {
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["192.168.1.50"]) };
      await expect(validateUrlSafety("http://10.0.0.1/", options)).rejects.toThrow(UrlSafetyError);
    });

    it("still rejects non-http schemes even with whitelist", async () => {
      const options: SafeFetchOptions = { blockPrivateResolution: true, allowedPrivateHosts: new Set(["anything"]) };
      await expect(validateUrlSafety("file:///etc/passwd", options)).rejects.toThrow(UrlSafetyError);
    });
  });

  describe("when blockPrivateResolution is false (default)", () => {
    it("allows private IP literals", async () => {
      await expect(validateUrlSafety("http://192.168.1.1/")).resolves.toBeUndefined();
    });

    it("allows loopback", async () => {
      await expect(validateUrlSafety("http://127.0.0.1/")).resolves.toBeUndefined();
    });

    it("allows hostnames resolving to private IPs", async () => {
      mockResolve4.mockResolvedValue(["10.0.0.1"]);
      await expect(validateUrlSafety("http://radicale.local/")).resolves.toBeUndefined();
    });
  });
});

type FetchFn = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

const installMockFetch = (mockFn: ReturnType<typeof vi.fn<FetchFn>>): void => {
  Object.assign(globalThis, { fetch: mockFn });
};

describe("createSafeFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sets redirect to manual", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch(enabledOptions);
    await safeFetch("https://example.com/cal.ics");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callInit = mockFetch.mock.calls[0]?.[1];
    expect(callInit?.redirect).toBe("manual");
  });

  it("rejects redirects to private IPs", async () => {
    mockResolve4.mockResolvedValueOnce(["93.184.216.34"]);

    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      }),
    );
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch(enabledOptions);
    await expect(safeFetch("https://example.com/cal.ics")).rejects.toThrow(UrlSafetyError);
  });

  it("follows safe redirects", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://example.com/new-cal.ics" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response("calendar data", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch(enabledOptions);
    const response = await safeFetch("https://example.com/cal.ics");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("enforces max redirect depth", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/redirect" },
        }),
      ),
    );
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch(enabledOptions);
    await expect(safeFetch("https://example.com/cal.ics")).rejects.toThrow("Too many redirects");
  });

  it("rejects initial request to private IP when enabled", async () => {
    const safeFetch = createSafeFetch(enabledOptions);
    await expect(safeFetch("http://10.0.0.1/internal")).rejects.toThrow(UrlSafetyError);
  });

  it("allows private IPs when blockPrivateResolution is false", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch();
    const response = await safeFetch("http://10.0.0.1/cal.ics");

    expect(response.status).toBe(200);
  });

  it("allows whitelisted private hosts when enabled", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch({ blockPrivateResolution: true, allowedPrivateHosts: new Set(["10.0.0.1"]) });
    const response = await safeFetch("http://10.0.0.1/cal.ics");

    expect(response.status).toBe(200);
  });

  it("propagates a configured abort signal to requests", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch({ signal: controller.signal });
    const request = safeFetch("https://example.com/calendar");
    controller.abort(new Error("job deadline exceeded"));

    await expect(request).rejects.toThrow("job deadline exceeded");
  });
});

const sentHeaders = (input: string | Request | URL, init: RequestInit | undefined): Headers => {
  const merged = new Headers();
  if (input instanceof Request) {
    for (const [key, value] of input.headers.entries()) {
      merged.set(key, value);
    }
  }
  for (const [key, value] of new Headers(init?.headers).entries()) {
    merged.set(key, value);
  }
  return merged;
};

describe("pinning leaves the existing guard behaviour unchanged", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never resolves DNS when blockPrivateResolution is off", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch();
    await safeFetch("https://feeds.example.com/cal.ics");

    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("does not pin or rewrite the request when blockPrivateResolution is off", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch();
    await safeFetch("https://feeds.example.com/cal.ics");

    const [input, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://feeds.example.com/cal.ics");
    expect(sentHeaders(input ?? "", init).get("host")).toBeNull();
    expect((init as (RequestInit & { tls?: unknown }) | undefined)?.tls).toBeUndefined();
  });

  it("resolves no DNS and issues no request for a literal private IP when enabled", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch(enabledOptions);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(UrlSafetyError);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("leaves a whitelisted private host unpinned and untouched", async () => {
    const mockFetch = vi.fn<FetchFn>();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    installMockFetch(mockFetch);

    const safeFetch = createSafeFetch({ blockPrivateResolution: true, allowedPrivateHosts: new Set(["radicale.local:5232"]) });
    await safeFetch("http://radicale.local:5232/cal.ics");

    const [input, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(input)).toBe("http://radicale.local:5232/cal.ics");
    expect(sentHeaders(input ?? "", init).get("host")).toBeNull();
    expect(mockResolve4).not.toHaveBeenCalled();
  });
});
