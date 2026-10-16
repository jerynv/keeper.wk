import { and, eq, lte } from "drizzle-orm";
import { locksTable } from "./schema";
import type { Database } from "./client";

/*
 * A lease is a row in `locks` that some holder owns until expiresAt. It stands in for
 * Postgres advisory locks and upstream's Redis sync lock. D1 has no
 * interactive transactions, so a held lease is the only mutual exclusion available
 * across concurrent Worker invocations.
 *
 * Taking a lease is one statement: insert the row, or take it over only when the
 * current one has expired. RETURNING yields a row exactly when this caller won, which
 * makes the check a compare-and-swap on rows changed, never a read followed by a write.
 */

interface LeaseHandle {
  readonly key: string;
  readonly holder: string;
  isHeld: () => Promise<boolean>;
  renew: () => Promise<boolean>;
  release: () => Promise<void>;
}

const tryAcquireLease = async (
  database: Database,
  key: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> => {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const rows = await database
    .insert(locksTable)
    .values({ expiresAt, holder, key })
    .onConflictDoUpdate({
      set: { expiresAt, holder },
      setWhere: lte(locksTable.expiresAt, now),
      target: locksTable.key,
    })
    .returning({ holder: locksTable.holder });
  return rows.length === 1 && rows[0]?.holder === holder;
};

const isLeaseHeld = async (database: Database, key: string, holder: string): Promise<boolean> => {
  const [row] = await database
    .select({ expiresAt: locksTable.expiresAt, holder: locksTable.holder })
    .from(locksTable)
    .where(eq(locksTable.key, key));
  return row?.holder === holder && row.expiresAt > Date.now();
};

// Whether anyone holds the key right now, for a caller that must yield to that holder.
const isLeaseLive = async (database: Database, key: string): Promise<boolean> => {
  const [row] = await database
    .select({ expiresAt: locksTable.expiresAt })
    .from(locksTable)
    .where(eq(locksTable.key, key));
  if (!row) {
    return false;
  }
  return row.expiresAt > Date.now();
};

const renewLease = async (
  database: Database,
  key: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> => {
  const rows = await database
    .update(locksTable)
    .set({ expiresAt: Date.now() + ttlMs })
    .where(and(eq(locksTable.key, key), eq(locksTable.holder, holder)))
    .returning({ key: locksTable.key });
  return rows.length === 1;
};

const releaseLease = async (database: Database, key: string, holder: string): Promise<void> => {
  await database
    .delete(locksTable)
    .where(and(eq(locksTable.key, key), eq(locksTable.holder, holder)));
};

const createLeaseHandle = (
  database: Database,
  key: string,
  holder: string,
  ttlMs: number,
): LeaseHandle => ({
  holder,
  isHeld: () => isLeaseHeld(database, key, holder),
  key,
  release: () => releaseLease(database, key, holder),
  renew: () => renewLease(database, key, holder, ttlMs),
});

const acquireLease = async (
  database: Database,
  key: string,
  ttlMs: number,
): Promise<LeaseHandle | null> => {
  const holder = crypto.randomUUID();
  if (!await tryAcquireLease(database, key, holder, ttlMs)) {
    return null;
  }
  return createLeaseHandle(database, key, holder, ttlMs);
};

class LeaseUnavailableError extends Error {
  public readonly key: string;

  public constructor(key: string) {
    super(`Lease ${key} is held by another run`);
    this.name = "LeaseUnavailableError";
    this.key = key;
  }
}

interface WaitForLeasesOptions {
  ttlMs: number;
  waitMs: number;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 250;

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/*
 * Takes every key in sorted order (so two callers wanting overlapping sets cannot
 * deadlock), waiting up to waitMs for each, runs work, then releases all of them. A key
 * still held at the deadline throws LeaseUnavailableError after releasing the rest.
 */
const withLeases = async <TResult>(
  database: Database,
  keys: string[],
  options: WaitForLeasesOptions,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  const ordered = [...new Set(keys)].toSorted();
  const held: LeaseHandle[] = [];
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadlineAt = Date.now() + options.waitMs;
  try {
    for (const key of ordered) {
      let handle = await acquireLease(database, key, options.ttlMs);
      while (!handle) {
        if (Date.now() >= deadlineAt) {
          throw new LeaseUnavailableError(key);
        }
        await sleep(pollMs);
        handle = await acquireLease(database, key, options.ttlMs);
      }
      held.push(handle);
    }
    return await work();
  } finally {
    await Promise.all(held.map((handle) => handle.release()));
  }
};

export {
  LeaseUnavailableError,
  acquireLease,
  isLeaseHeld,
  isLeaseLive,
  releaseLease,
  renewLease,
  tryAcquireLease,
  withLeases,
};
export type { LeaseHandle, WaitForLeasesOptions };
