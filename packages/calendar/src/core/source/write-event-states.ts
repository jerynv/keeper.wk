import { chunkRowsForInsert, runBatch } from "@keeper.sh/database";
import type { Database, DatabaseBatchItem } from "@keeper.sh/database";
import { eventStatesTable } from "@keeper.sh/database/schema";
import { isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { IcsExceptionDates, IcsRecurrenceRule } from "ts-ics";
import type { SourceEvent } from "../types";
import { serializeStoredIcsRecurrenceRule } from "../events/stored-recurrence";

type EventStateInsertRow = typeof eventStatesTable.$inferInsert;

const serializeOptionalJson = (
  value: IcsExceptionDates | IcsRecurrenceRule | undefined,
): string | null => {
  if (!value) {
    return null;
  }
  return JSON.stringify(value);
};

const buildEventStateInsertRow = (
  calendarId: string,
  event: SourceEvent,
): EventStateInsertRow => ({
  availability: event.availability,
  calendarId,
  description: event.description,
  endTime: event.endTime,
  exceptionDates: serializeOptionalJson(event.exceptionDates),
  isAllDay: event.isAllDay,
  location: event.location,
  recurrenceId: event.recurrenceId,
  recurrenceRule: serializeStoredIcsRecurrenceRule(
    event.recurrenceRule,
    event.recurrenceDuration,
  ),
  sourceEventId: event.sourceEventId,
  sourceEventType: event.sourceEventType ?? "default",
  sourceEventUid: event.uid,
  startTime: event.startTime,
  startTimeZone: event.startTimeZone,
  title: event.title,
});

const LEGACY_RECURRING_EVENT_STATE_CONFLICT_TARGET: [
  typeof eventStatesTable.calendarId,
  typeof eventStatesTable.sourceEventUid,
  typeof eventStatesTable.recurrenceId,
] = [
  eventStatesTable.calendarId,
  eventStatesTable.sourceEventUid,
  eventStatesTable.recurrenceId,
];

const LEGACY_NON_RECURRING_EVENT_STATE_CONFLICT_TARGET: [
  typeof eventStatesTable.calendarId,
  typeof eventStatesTable.sourceEventUid,
  typeof eventStatesTable.startTime,
  typeof eventStatesTable.endTime,
] = [
  eventStatesTable.calendarId,
  eventStatesTable.sourceEventUid,
  eventStatesTable.startTime,
  eventStatesTable.endTime,
];

const PROVIDER_EVENT_STATE_CONFLICT_TARGET: [
  typeof eventStatesTable.calendarId,
  typeof eventStatesTable.sourceEventId,
] = [
  eventStatesTable.calendarId,
  eventStatesTable.sourceEventId,
];

const excludedColumn = (columnName: string) => sql.raw(`excluded."${columnName}"`);

const EVENT_STATE_CONFLICT_SET = {
  availability: excludedColumn(eventStatesTable.availability.name),
  description: excludedColumn(eventStatesTable.description.name),
  exceptionDates: excludedColumn(eventStatesTable.exceptionDates.name),
  isAllDay: excludedColumn(eventStatesTable.isAllDay.name),
  location: excludedColumn(eventStatesTable.location.name),
  recurrenceRule: excludedColumn(eventStatesTable.recurrenceRule.name),
  recurrenceId: excludedColumn(eventStatesTable.recurrenceId.name),
  sourceEventId: excludedColumn(eventStatesTable.sourceEventId.name),
  sourceEventType: excludedColumn(eventStatesTable.sourceEventType.name),
  sourceEventUid: excludedColumn(eventStatesTable.sourceEventUid.name),
  startTime: excludedColumn(eventStatesTable.startTime.name),
  startTimeZone: excludedColumn(eventStatesTable.startTimeZone.name),
  endTime: excludedColumn(eventStatesTable.endTime.name),
  title: excludedColumn(eventStatesTable.title.name),
};

const PROVIDER_EVENT_STATE_CONFLICT_SET = EVENT_STATE_CONFLICT_SET;

type EventStateConflictTarget =
  | typeof LEGACY_RECURRING_EVENT_STATE_CONFLICT_TARGET
  | typeof LEGACY_NON_RECURRING_EVENT_STATE_CONFLICT_TARGET
  | typeof PROVIDER_EVENT_STATE_CONFLICT_TARGET;

interface EventStateConflictConfig {
  target: EventStateConflictTarget;
  targetWhere: SQL;
  set: Record<string, SQL>;
}

/*
 * One statement per chunk, sized under D1's 100-parameter cap, returned
 * rather than run so a caller can put them in the same batch() as its deletes and
 * keep the whole ingest write atomic (T1).
 */
const buildEventStateRowStatements = (
  database: Database,
  rows: EventStateInsertRow[],
  conflictConfig: EventStateConflictConfig,
): DatabaseBatchItem[] =>
  chunkRowsForInsert(eventStatesTable, rows).map((chunk) => database
    .insert(eventStatesTable)
    .values(chunk)
    .onConflictDoUpdate(conflictConfig));

const buildEventStateInsertStatements = (
  database: Database,
  rows: EventStateInsertRow[],
): DatabaseBatchItem[] => {
  const providerRows: EventStateInsertRow[] = [];
  const legacyRecurringRows: EventStateInsertRow[] = [];
  const legacyNonRecurringRows: EventStateInsertRow[] = [];

  for (const row of rows) {
    if (row.sourceEventId) {
      providerRows.push(row);
    } else if (row.recurrenceId) {
      legacyRecurringRows.push(row);
    } else {
      legacyNonRecurringRows.push(row);
    }
  }

  return [
    ...buildEventStateRowStatements(database, providerRows, {
      set: PROVIDER_EVENT_STATE_CONFLICT_SET,
      target: PROVIDER_EVENT_STATE_CONFLICT_TARGET,
      targetWhere: isNotNull(eventStatesTable.sourceEventId),
    }),
    ...buildEventStateRowStatements(database, legacyRecurringRows, {
      set: EVENT_STATE_CONFLICT_SET,
      target: LEGACY_RECURRING_EVENT_STATE_CONFLICT_TARGET,
      targetWhere: sql`${eventStatesTable.sourceEventId} is null and ${eventStatesTable.recurrenceId} is not null`,
    }),
    ...buildEventStateRowStatements(database, legacyNonRecurringRows, {
      set: EVENT_STATE_CONFLICT_SET,
      target: LEGACY_NON_RECURRING_EVENT_STATE_CONFLICT_TARGET,
      targetWhere: sql`${eventStatesTable.sourceEventId} is null and ${eventStatesTable.recurrenceId} is null`,
    }),
  ];
};

const insertEventStatesWithConflictResolution = async (
  database: Database,
  rows: EventStateInsertRow[],
): Promise<void> => {
  await runBatch(database, buildEventStateInsertStatements(database, rows));
};

export {
  buildEventStateInsertRow,
  buildEventStateInsertStatements,
  insertEventStatesWithConflictResolution,
};
export type { EventStateInsertRow };
