import { withLeases } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";

/*
 * Upstream held pg_advisory_xact_lock(namespace, hashtext(calendarId)) for the length of
 * a transaction. D1 has no interactive transactions, so the same mutual exclusion is a
 * lease per source calendar: an ingest's persistence step and a
 * destination's read of that source's events never interleave.
 */
const SOURCE_INGEST_LEASE_PREFIX = "source-ingest:";
// How long to wait for another run to finish with a source before giving up this one.
const SOURCE_INGEST_LOCK_TIMEOUT_MS = 30_000;
// A crashed holder's lease frees itself after this; a live one finishes well inside it.
const SOURCE_INGEST_LEASE_TTL_MS = 120_000;

const toSourceIngestLeaseKey = (calendarId: string): string =>
  `${SOURCE_INGEST_LEASE_PREFIX}${calendarId}`;

const withSourceIngestLocks = <TResult>(
  database: Database,
  calendarIds: string[],
  work: (lockedDatabase: Database) => Promise<TResult>,
): Promise<TResult> => {
  if (calendarIds.length === 0) {
    return work(database);
  }
  return withLeases(
    database,
    calendarIds.map((calendarId) => toSourceIngestLeaseKey(calendarId)),
    { ttlMs: SOURCE_INGEST_LEASE_TTL_MS, waitMs: SOURCE_INGEST_LOCK_TIMEOUT_MS },
    () => work(database),
  );
};

const withSourceIngestLock = <TResult>(
  database: Database,
  calendarId: string,
  work: (lockedDatabase: Database) => Promise<TResult>,
): Promise<TResult> => withSourceIngestLocks(database, [calendarId], work);

export {
  SOURCE_INGEST_LEASE_TTL_MS,
  SOURCE_INGEST_LOCK_TIMEOUT_MS,
  toSourceIngestLeaseKey,
  withSourceIngestLock,
  withSourceIngestLocks,
};
