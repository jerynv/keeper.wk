interface RateLimiterPermit {
  release(): Promise<void>;
}

/*
 * Providers take this optionally and pace their requests through it. Upstream backed it
 * with Redis so a fleet of workers shared one quota; a single-user Worker passes none.
 */
interface RequestRateLimiter {
  acquire(count: number, signal?: AbortSignal): Promise<void>;
  acquirePermit?(signal?: AbortSignal): Promise<RateLimiterPermit>;
}

export type { RateLimiterPermit, RequestRateLimiter };
