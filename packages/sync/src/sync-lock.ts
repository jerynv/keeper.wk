import { acquireLease, isLeaseLive } from "@keeper.sh/database";
import type { Database, LeaseHandle } from "@keeper.sh/database";

/*
 * Upstream ran this lock in Redis with a waiter queue, so a mapping mutation could
 * preempt a background sync and a second sync could queue behind the first. With one
 * user and a one-minute cadence that machinery buys nothing: a run that
 * cannot take the lease skips, and the next tick tries again. A mapping mutation
 * (settings page edits) holds its own lease, which blocks syncs of that user while held.
 */
const LOCK_PREFIX = "sync:lock:";
const MAPPING_MUTATION_LOCK_PREFIX = "mapping-mutation:";
const LOCK_TTL_MS = 120_000;
const LOCK_RENEW_INTERVAL_MS = LOCK_TTL_MS / 3;

interface SyncLockHandle {
  isHeld: () => Promise<boolean>;
  isCurrent: () => Promise<boolean>;
  release: () => Promise<void>;
}

class SyncLockRenewalError extends Error {
  public readonly calendarId: string;

  public constructor(calendarId: string, cause: unknown) {
    super(`Failed to renew sync lock for calendar ${calendarId}`, { cause });
    this.name = "SyncLockRenewalError";
    this.calendarId = calendarId;
  }
}

interface AcquireSyncLockResult {
  acquired: true;
  handle: SyncLockHandle;
}

interface SyncLockSkippedResult {
  acquired: false;
}

const createLockHandle = (calendarId: string, lease: LeaseHandle): SyncLockHandle => {
  const renewalState: { error?: unknown } = {};
  const renewalTimer = setInterval(async () => {
    try {
      await lease.renew();
      // A later success proves the lease is still ours, so one blip must not strand the run.
      delete renewalState.error;
    } catch (error) {
      renewalState.error = error;
    }
  }, LOCK_RENEW_INTERVAL_MS);

  const isHeld = async (): Promise<boolean> => {
    if ("error" in renewalState) {
      throw new SyncLockRenewalError(calendarId, renewalState.error);
    }
    return await lease.isHeld();
  };

  const release = async (): Promise<void> => {
    clearInterval(renewalTimer);
    await lease.release();
  };

  // No waiter can supersede a holder here, so "current" is simply "still held".
  return { isCurrent: isHeld, isHeld, release };
};

const createSyncLock = (database: Database) => {
  const acquire = async (
    calendarId: string,
    abortSignal?: AbortSignal,
    blockerKey?: string,
  ): Promise<AcquireSyncLockResult | SyncLockSkippedResult> => {
    if (abortSignal?.aborted) {
      return { acquired: false };
    }
    const lease = await acquireLease(database, `${LOCK_PREFIX}${calendarId}`, LOCK_TTL_MS);
    if (!lease) {
      return { acquired: false };
    }
    if (blockerKey && await isLeaseLive(database, `${LOCK_PREFIX}${blockerKey}`)) {
      await lease.release();
      return { acquired: false };
    }
    return { acquired: true, handle: createLockHandle(calendarId, lease) };
  };

  return { acquire };
};

const createMappingMutationLockId = (userId: string): string =>
  `${MAPPING_MUTATION_LOCK_PREFIX}${userId}`;

export {
  createLockHandle,
  createMappingMutationLockId,
  createSyncLock,
  LOCK_PREFIX,
  LOCK_RENEW_INTERVAL_MS,
  LOCK_TTL_MS,
  SyncLockRenewalError,
};
export type { AcquireSyncLockResult, SyncLockHandle, SyncLockSkippedResult };
