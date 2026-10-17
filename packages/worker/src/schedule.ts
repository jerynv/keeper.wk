import { hasCapability } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";
import { calendarsTable, eventMappingsTable, sourceDestinationMappingsTable } from "@keeper.sh/database/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import type { SyncMessage } from "./messages";

/*
 * The cron's whole job: name every unit of work for this minute. Sources are ingested
 * only while something maps them to a destination, since no one reads an unmapped
 * source's events. Destinations are reconciled while they have a mapped source, and also
 * while mirrors remain from a source that was unmapped, so those get retired.
 */
const planScheduledMessages = async (database: Database): Promise<SyncMessage[]> => {
  const sources = await database
    .selectDistinct({ calendarId: calendarsTable.id })
    .from(calendarsTable)
    .innerJoin(sourceDestinationMappingsTable, eq(sourceDestinationMappingsTable.sourceCalendarId, calendarsTable.id))
    .where(and(eq(calendarsTable.disabled, false), hasCapability(calendarsTable.capabilities, "pull")));

  const destinations = await database
    .select({ calendarId: calendarsTable.id })
    .from(calendarsTable)
    .where(and(
      eq(calendarsTable.disabled, false),
      hasCapability(calendarsTable.capabilities, "push"),
      or(
        inArray(calendarsTable.id, database
          .select({ id: sourceDestinationMappingsTable.destinationCalendarId })
          .from(sourceDestinationMappingsTable)),
        inArray(calendarsTable.id, database
          .select({ id: eventMappingsTable.calendarId })
          .from(eventMappingsTable)),
      ),
    ));

  return [
    ...sources.map(({ calendarId }): SyncMessage => ({ calendarId, kind: "ingest" })),
    ...destinations.map(({ calendarId }): SyncMessage => ({ calendarId, kind: "push" })),
  ];
};

// After an ingest changed something, reconcile its destinations now instead of next minute.
const planPushesForSource = async (database: Database, sourceCalendarId: string): Promise<SyncMessage[]> => {
  const rows = await database
    .select({ calendarId: sourceDestinationMappingsTable.destinationCalendarId })
    .from(sourceDestinationMappingsTable)
    .where(eq(sourceDestinationMappingsTable.sourceCalendarId, sourceCalendarId));
  return rows.map(({ calendarId }): SyncMessage => ({ calendarId, kind: "push" }));
};

export { planPushesForSource, planScheduledMessages };
