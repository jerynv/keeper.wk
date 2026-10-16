import { chunkForParameters, chunkRowsForInsert, runBatch } from "@keeper.sh/database";
import type { Database, DatabaseBatchItem } from "@keeper.sh/database";
import { eventMappingsTable } from "@keeper.sh/database/schema";
import { eq, inArray } from "drizzle-orm";
import type { PendingChanges } from "./types";

/*
 * Upstream wrote a flush inside one Postgres transaction. D1 rejects BEGIN, so the same
 * all-or-nothing write is one batch(), chunked under D1's 100-parameter
 * cap (T2). A mapping is either recorded with every other change of the run or not at
 * all, which is what keeps a pushed mirror from being written twice.
 */
const buildFlushStatements = (
  database: Database,
  changes: PendingChanges,
): DatabaseBatchItem[] => {
  const statements: DatabaseBatchItem[] = [];

  for (const ids of chunkForParameters(changes.deletes)) {
    statements.push(database
      .delete(eventMappingsTable)
      .where(inArray(eventMappingsTable.id, ids)));
  }

  const insertRows = changes.inserts.map((insert) => ({
    calendarId: insert.calendarId,
    deleteIdentifier: insert.deleteIdentifier,
    destinationEventUid: insert.destinationEventUid,
    endTime: insert.endTime,
    eventStateId: insert.eventStateId,
    sourceCalendarId: insert.sourceCalendarId,
    startTime: insert.startTime,
    syncEventHash: insert.syncEventHash,
    syncEventId: insert.syncEventId,
  }));
  for (const rows of chunkRowsForInsert(eventMappingsTable, insertRows)) {
    statements.push(database
      .insert(eventMappingsTable)
      .values(rows)
      .onConflictDoNothing());
  }

  for (const update of changes.updates ?? []) {
    statements.push(database
      .update(eventMappingsTable)
      .set({
        deleteIdentifier: update.deleteIdentifier,
        endTime: update.endTime,
        startTime: update.startTime,
        syncEventHash: update.syncEventHash,
        syncEventId: update.syncEventId,
      })
      .where(eq(eventMappingsTable.id, update.id)));
  }

  return statements;
};

const createDatabaseFlush = (database: Database): (changes: PendingChanges) => Promise<void> =>
  async (changes: PendingChanges): Promise<void> => {
    await runBatch(database, buildFlushStatements(database, changes));
  };

export { buildFlushStatements, createDatabaseFlush };
