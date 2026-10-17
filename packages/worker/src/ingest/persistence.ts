import {
  buildEventStateInsertRow,
  buildEventStateInsertStatements,
  withSourceIngestLock,
} from "@keeper.sh/calendar";
import type { IngestionPersistenceWork, IngestionResult } from "@keeper.sh/calendar";
import { buildPersistCalendarSnapshot } from "@keeper.sh/calendar/ics";
import { chunkForParameters, runBatch } from "@keeper.sh/database";
import type { Database, DatabaseBatchItem } from "@keeper.sh/database";
import { calendarsTable, eventStatesTable } from "@keeper.sh/database/schema";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

/*
 * Another ingest of this source committed between this run's fetch and its write. Applying
 * this run's diff on top would undo the newer one, so the run stops and the next tick reads
 * the newer state instead.
 */
class IngestBaselineMovedError extends Error {
  public constructor(calendarId: string, expected: number, found: number) {
    super(`Ingest baseline for ${calendarId} moved from ${expected} to ${found}`);
    this.name = "IngestBaselineMovedError";
  }
}

const STORED_EVENT_STATE_COLUMNS = {
  availability: eventStatesTable.availability,
  description: eventStatesTable.description,
  endTime: eventStatesTable.endTime,
  exceptionDates: eventStatesTable.exceptionDates,
  id: eventStatesTable.id,
  isAllDay: eventStatesTable.isAllDay,
  location: eventStatesTable.location,
  recurrenceId: eventStatesTable.recurrenceId,
  recurrenceRule: eventStatesTable.recurrenceRule,
  sourceEventId: eventStatesTable.sourceEventId,
  sourceEventType: eventStatesTable.sourceEventType,
  sourceEventUid: eventStatesTable.sourceEventUid,
  startTime: eventStatesTable.startTime,
  startTimeZone: eventStatesTable.startTimeZone,
  title: eventStatesTable.title,
};

type IngestionChanges = Parameters<Parameters<IngestionPersistenceWork>[0]["flush"]>[0];

/*
 * Every write of one ingest, as one batch: the event-state diff, the sync
 * token, the coverage window, the snapshot hash and the ingestSeq bump land together or
 * not at all. Upstream ran the same writes inside one Postgres transaction.
 */
const buildIngestFlushStatements = (
  database: Database,
  calendarId: string,
  changes: IngestionChanges,
): DatabaseBatchItem[] => {
  const statements: DatabaseBatchItem[] = [];

  // One more bound parameter beside the ids: the calendar id.
  for (const ids of chunkForParameters(changes.deletes, 1, 1)) {
    statements.push(database
      .delete(eventStatesTable)
      .where(and(eq(eventStatesTable.calendarId, calendarId), inArray(eventStatesTable.id, ids))));
  }

  statements.push(...buildEventStateInsertStatements(
    database,
    changes.inserts.map((event) => buildEventStateInsertRow(calendarId, event)),
  ));

  if ("syncToken" in changes) {
    statements.push(database
      .update(calendarsTable)
      .set({ syncToken: changes.syncToken ?? null })
      .where(eq(calendarsTable.id, calendarId)));
  }

  if (changes.coverage) {
    const { futureRange, historicRange, window } = changes.coverage;
    // The window is day-anchored, so an unconditional rewrite would churn updatedAt every tick.
    statements.push(database
      .update(calendarsTable)
      .set({
        ingestFutureRange: futureRange,
        ingestHistoricRange: historicRange,
        ingestWindowEnd: window.timeMax,
        ingestWindowRecordedAt: new Date(),
        ingestWindowStart: window.timeMin,
      })
      .where(and(
        eq(calendarsTable.id, calendarId),
        or(
          isNull(calendarsTable.ingestWindowRecordedAt),
          isNull(calendarsTable.ingestWindowStart),
          isNull(calendarsTable.ingestWindowEnd),
          ne(calendarsTable.ingestFutureRange, futureRange),
          ne(calendarsTable.ingestHistoricRange, historicRange),
          ne(calendarsTable.ingestWindowStart, window.timeMin),
          ne(calendarsTable.ingestWindowEnd, window.timeMax),
        ),
      )));
  }

  if (changes.snapshot) {
    statements.push(buildPersistCalendarSnapshot(database, calendarId, changes.snapshot));
  }

  statements.push(database
    .update(calendarsTable)
    .set({ ingestSeq: sql`${calendarsTable.ingestSeq} + 1` })
    .where(eq(calendarsTable.id, calendarId)));

  return statements;
};

const readIngestSeq = async (database: Database, calendarId: string): Promise<number | null> => {
  const [row] = await database
    .select({ ingestSeq: calendarsTable.ingestSeq })
    .from(calendarsTable)
    .where(eq(calendarsTable.id, calendarId))
    .limit(1);
  return row?.ingestSeq ?? null;
};

/*
 * The persistence step of one ingest, under the source lease that destination reads also
 * take, so a destination never reads half of an ingest. The lease covers only this step;
 * the provider fetch before it runs under the run lease (see run-source.ts).
 */
const createLeasedIngestionPersistence = (
  database: Database,
  calendarId: string,
  baselineIngestSeq: number,
) => async (work: IngestionPersistenceWork): Promise<IngestionResult> => {
  const preflighted = await work.preflight?.();
  if (preflighted) {
    return preflighted;
  }
  return withSourceIngestLock(database, calendarId, async () => {
    const storedIngestSeq = await readIngestSeq(database, calendarId);
    if (storedIngestSeq !== null && storedIngestSeq !== baselineIngestSeq) {
      throw new IngestBaselineMovedError(calendarId, baselineIngestSeq, storedIngestSeq);
    }
    return work({
      flush: async (changes) => {
        await runBatch(database, buildIngestFlushStatements(database, calendarId, changes));
      },
      readExistingEvents: () => database
        .select(STORED_EVENT_STATE_COLUMNS)
        .from(eventStatesTable)
        .where(eq(eventStatesTable.calendarId, calendarId)),
    });
  });
};

export { IngestBaselineMovedError, buildIngestFlushStatements, createLeasedIngestionPersistence };
