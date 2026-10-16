import { beforeEach, describe, expect, it } from "vitest";
import { widelog, widelogger } from "../../../src/core/telemetry/widelog";
import { withBackoff } from "../../../src/core/utils/backoff";

interface EmittedEvent {
  accounted_ms?: number;
  provider?: { retry_count?: number };
  source?: string;
  wait?: { provider_retry_ms?: number };
}

const emitted: EmittedEvent[] = [];

const { context } = widelogger({
  defaultEventName: "wide_event",
  environment: "production",
  service: "calendar-test",
  transport: (event) => {
    emitted.push(event as EmittedEvent);
  },
});

beforeEach(() => {
  emitted.length = 0;
});

const RETRY_DELAY_MS = 120;

/*
 * A timer can return a fraction of a millisecond before the span measuring it elapses, so
 * an exact floor makes these assertions report timer granularity rather than attribution.
 * The slack is far smaller than any injected delay, so a segment charged to the wrong bucket
 * still fails.
 */
const TIMER_SLACK_MS = 5;

const chargedAtLeast = (injectedMs: number): number => injectedMs - TIMER_SLACK_MS;


const runInEvent = async (source: string, run: () => Promise<void>): Promise<void> => {
  await context(async () => {
    widelog.set("source", source);
    await run();
    widelog.flush();
  });
};

const eventFor = (source: string): EmittedEvent => {
  const event = emitted.find((candidate) => candidate.source === source);
  if (!event) {
    throw new Error(`no wide event was emitted for ${source}`);
  }
  return event;
};

const succeedAfter = (failures: number) => {
  let remaining = failures;
  return (): Promise<string> => {
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new Error("rate limited"));
    }
    return Promise.resolve("done");
  };
};

const retryOptions = {
  getRetryDelayMs: () => RETRY_DELAY_MS,
  shouldRetry: () => true,
};

describe("provider retry wait attribution", () => {
  it("charges the retry sleep to the wide event the caller opened", async () => {
    await runInEvent("retried", async () => {
      await withBackoff(succeedAfter(2), retryOptions);
    });

    const event = eventFor("retried");
    expect(event.provider?.retry_count).toBe(2);
    expect(event.wait?.provider_retry_ms).toBeGreaterThanOrEqual(chargedAtLeast(RETRY_DELAY_MS * 2));
    expect(event.accounted_ms).toBe(event.wait?.provider_retry_ms);
  });

  it("leaves both fields absent when nothing retried", async () => {
    await runInEvent("clean", async () => {
      await withBackoff(succeedAfter(0), retryOptions);
    });

    const event = eventFor("clean");
    expect(event.provider?.retry_count).toBeUndefined();
    expect(event.wait?.provider_retry_ms).toBeUndefined();
  });

  it("gives two concurrent operations their own retry totals", async () => {
    await Promise.all([
      runInEvent("three", async () => {
        await withBackoff(succeedAfter(3), retryOptions);
      }),
      runInEvent("one", async () => {
        await withBackoff(succeedAfter(1), retryOptions);
      }),
    ]);

    expect(eventFor("three").provider?.retry_count).toBe(3);
    expect(eventFor("one").provider?.retry_count).toBe(1);
    expect(eventFor("three").wait?.provider_retry_ms ?? 0)
      .toBeGreaterThan(eventFor("one").wait?.provider_retry_ms ?? 0);
  });

  it("stops the timer when the sleep is aborted", async () => {
    const controller = new AbortController();

    await runInEvent("aborted", async () => {
      const pending = withBackoff(succeedAfter(5), { ...retryOptions, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("source deadline exceeded")), RETRY_DELAY_MS / 2);
      await pending.catch(() => null);
    });

    const event = eventFor("aborted");
    expect(event.wait?.provider_retry_ms).toBeGreaterThan(0);
    expect(event.provider?.retry_count).toBe(1);
  });
});
