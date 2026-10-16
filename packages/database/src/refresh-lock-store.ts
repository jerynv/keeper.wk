import { releaseLease, tryAcquireLease } from "./leases";
import type { Database } from "./client";

const MS_PER_SECOND = 1000;

/*
 * Backs the OAuth refresh coordinator's lock with a D1 lease, so two consumers never
 * race a refresh-token rotation. Each store instance is one holder.
 */
const createRefreshLockStore = (database: Database) => {
  const holder = crypto.randomUUID();
  return {
    release: (key: string): Promise<void> => releaseLease(database, key, holder),
    tryAcquire: (key: string, ttlSeconds: number): Promise<boolean> =>
      tryAcquireLease(database, key, holder, ttlSeconds * MS_PER_SECOND),
  };
};

export { createRefreshLockStore };
