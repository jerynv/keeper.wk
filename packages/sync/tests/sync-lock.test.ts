import { env } from "cloudflare:workers";
import { createDatabase, releaseLease, tryAcquireLease } from "@keeper.sh/database";
import type { LeaseHandle } from "@keeper.sh/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCK_PREFIX,
  LOCK_RENEW_INTERVAL_MS,
  SyncLockRenewalError,
  createLockHandle,
  createMappingMutationLockId,
  createSyncLock,
} from "../src/sync-lock";

const database = createDatabase(env.DB);
const calendarId = (): string => `calendar-${crypto.randomUUID()}`;
const NEVER_ABORTED = new AbortController().signal;

const fakeLease = (renew: () => Promise<boolean>): LeaseHandle => ({
  holder: "holder",
  isHeld: () => Promise.resolve(true),
  key: "key",
  release: () => Promise.resolve(),
  renew,
});

describe("createSyncLock (D1 lease)", () => {
  it("acquires a free calendar and refuses a second holder until it is released", async () => {
    const lock = createSyncLock(database);
    const id = calendarId();

    const first = await lock.acquire(id);
    const second = await lock.acquire(id);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    if (first.acquired) {
      expect(await first.handle.isHeld()).toBe(true);
      expect(await first.handle.isCurrent()).toBe(true);
      await first.handle.release();
    }
    const again = await lock.acquire(id);
    expect(again.acquired).toBe(true);
    if (again.acquired) {
      await again.handle.release();
    }
  });

  it("lets exactly one of many concurrent runs hold a calendar", async () => {
    const lock = createSyncLock(database);
    const id = calendarId();

    const results = await Promise.all(Array.from({ length: 10 }, () => lock.acquire(id)));

    const winners = results.filter((result) => result.acquired);
    expect(winners).toHaveLength(1);
    for (const winner of winners) {
      if (winner.acquired) {
        await winner.handle.release();
      }
    }
  });

  it("keeps different calendars independent", async () => {
    const lock = createSyncLock(database);
    const first = await lock.acquire(calendarId());
    const second = await lock.acquire(calendarId());

    expect(first.acquired && second.acquired).toBe(true);
    for (const result of [first, second]) {
      if (result.acquired) {
        await result.handle.release();
      }
    }
  });

  it("yields to a held mapping mutation and leaves no lease of its own behind", async () => {
    const lock = createSyncLock(database);
    const id = calendarId();
    const blocker = createMappingMutationLockId(crypto.randomUUID());
    expect(await tryAcquireLease(database, `${LOCK_PREFIX}${blocker}`, "settings-page", 60_000)).toBe(true);

    const blocked = await lock.acquire(id, NEVER_ABORTED, blocker);
    expect(blocked.acquired).toBe(false);

    await releaseLease(database, `${LOCK_PREFIX}${blocker}`, "settings-page");
    const after = await lock.acquire(id, NEVER_ABORTED, blocker);
    expect(after.acquired).toBe(true);
    if (after.acquired) {
      await after.handle.release();
    }
  });

  it("takes nothing for an already-aborted run", async () => {
    const lock = createSyncLock(database);
    const id = calendarId();
    const controller = new AbortController();
    controller.abort();

    const aborted = await lock.acquire(id, controller.signal);
    expect(aborted.acquired).toBe(false);
    const next = await lock.acquire(id);
    expect(next.acquired).toBe(true);
    if (next.acquired) {
      await next.handle.release();
    }
  });

  it("stops reporting itself current once another holder takes the lease", async () => {
    const lock = createSyncLock(database);
    const id = calendarId();
    const result = await lock.acquire(id);
    if (!result.acquired) {
      throw new Error("expected to acquire");
    }
    // Simulate the lease expiring under a stalled run and a later run taking it over.
    await database.run(`update locks set holder = 'later-run' where key = '${LOCK_PREFIX}${id}'`);

    expect(await result.handle.isCurrent()).toBe(false);
    await result.handle.release();
    // The stalled run's release must not free the later run's lease.
    const retry = await lock.acquire(id);
    expect(retry.acquired).toBe(false);
  });
});

describe("sync lock renewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers after a transient renewal failure is followed by a success", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handle = createLockHandle("calendar-1", fakeLease(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("blip"));
      }
      return Promise.resolve(true);
    }));

    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS);
    await expect(handle.isCurrent()).rejects.toBeInstanceOf(SyncLockRenewalError);

    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS);
    await expect(handle.isCurrent()).resolves.toBe(true);
    await handle.release();
  });

  it("stops renewing once released", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => Promise.resolve(true));
    const handle = createLockHandle("calendar-1", fakeLease(renew));

    await handle.release();
    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS * 3);

    expect(renew).not.toHaveBeenCalled();
  });
});
