import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  LeaseUnavailableError,
  acquireLease,
  createDatabase,
  isLeaseHeld,
  releaseLease,
  renewLease,
  tryAcquireLease,
  withLeases,
} from "../src";

const database = createDatabase(env.DB);
const uniqueKey = (label: string): string => `${label}:${crypto.randomUUID()}`;

describe("D1 leases", () => {
  it("lets exactly one of many concurrent callers take a free lease", async () => {
    const key = uniqueKey("race");
    const holders = Array.from({ length: 20 }, () => crypto.randomUUID());

    const outcomes = await Promise.all(
      holders.map((holder) => tryAcquireLease(database, key, holder, 60_000)),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = holders[outcomes.indexOf(true)] ?? "";
    expect(await isLeaseHeld(database, key, winner)).toBe(true);
  });

  it("refuses a held lease and grants it once the holder's lease has expired", async () => {
    const key = uniqueKey("expiry");
    expect(await tryAcquireLease(database, key, "first", 50)).toBe(true);
    expect(await tryAcquireLease(database, key, "second", 60_000)).toBe(false);

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(await tryAcquireLease(database, key, "second", 60_000)).toBe(true);
    expect(await isLeaseHeld(database, key, "first")).toBe(false);
    expect(await isLeaseHeld(database, key, "second")).toBe(true);
  });

  it("only lets the holder renew or release", async () => {
    const key = uniqueKey("ownership");
    expect(await tryAcquireLease(database, key, "owner", 60_000)).toBe(true);

    expect(await renewLease(database, key, "intruder", 60_000)).toBe(false);
    await releaseLease(database, key, "intruder");
    expect(await isLeaseHeld(database, key, "owner")).toBe(true);

    expect(await renewLease(database, key, "owner", 60_000)).toBe(true);
    await releaseLease(database, key, "owner");
    expect(await tryAcquireLease(database, key, "next", 60_000)).toBe(true);
  });

  it("reports a lease that expired under its holder as no longer held", async () => {
    const handle = await acquireLease(database, uniqueKey("lapse"), 30);
    expect(handle).not.toBeNull();
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(await handle?.isHeld()).toBe(false);
  });

  it("runs work under every key, then releases them all", async () => {
    const keys = [uniqueKey("b"), uniqueKey("a")];
    const heldDuringWork = await withLeases(
      database,
      keys,
      { ttlMs: 60_000, waitMs: 0 },
      () => Promise.all(keys.map((key) => tryAcquireLease(database, key, "other", 60_000))),
    );

    expect(heldDuringWork).toEqual([false, false]);
    for (const key of keys) {
      expect(await tryAcquireLease(database, key, "after", 60_000)).toBe(true);
    }
  });

  it("waits for a lease to free up within the budget", async () => {
    const key = uniqueKey("wait");
    expect(await tryAcquireLease(database, key, "blocker", 60_000)).toBe(true);
    setTimeout(async () => {
      await releaseLease(database, key, "blocker");
    }, 100);

    const result = await withLeases(database, [key], { pollMs: 20, ttlMs: 60_000, waitMs: 2000 }, () =>
      Promise.resolve("ran"));

    expect(result).toBe("ran");
  });

  it("gives up after the budget and leaves no partial leases behind", async () => {
    const free = uniqueKey("a-free");
    const blocked = uniqueKey("b-blocked");
    expect(await tryAcquireLease(database, blocked, "blocker", 60_000)).toBe(true);

    let ran = false;
    await expect(withLeases(database, [free, blocked], { pollMs: 10, ttlMs: 60_000, waitMs: 50 }, () => {
      ran = true;
      return Promise.resolve();
    })).rejects.toBeInstanceOf(LeaseUnavailableError);

    expect(ran).toBe(false);
    expect(await tryAcquireLease(database, free, "after", 60_000)).toBe(true);
  });

  it("releases its leases when the work throws", async () => {
    const key = uniqueKey("throw");
    await expect(withLeases(database, [key], { ttlMs: 60_000, waitMs: 0 }, () =>
      Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    expect(await tryAcquireLease(database, key, "after", 60_000)).toBe(true);
  });
});
