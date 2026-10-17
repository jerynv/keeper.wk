import { eventStatesTable } from "@keeper.sh/database/schema";
import { count, inArray } from "drizzle-orm";
import type { KeeperDatabase } from "./types";
import { getEventsInRange, getSourcesForUser } from "./get-events-in-range";

const EMPTY_RESULT_COUNT = 0;

interface EventCountOptions {
  from: Date;
  to: Date;
}

const countEventsInWindow = async (
  database: KeeperDatabase,
  userId: string,
  options: EventCountOptions,
): Promise<number> => {
  const events = await getEventsInRange(database, userId, {
    from: options.from,
    to: options.to,
  });

  return events.length;
};

const countAllEvents = async (
  database: KeeperDatabase,
  calendarIds: string[],
): Promise<number> => {
  const [syncedResult] = await database
    .select({ count: count() })
    .from(eventStatesTable)
    .where(inArray(eventStatesTable.calendarId, calendarIds));


  return syncedResult?.count ?? 0;
};

const getEventCount = async (
  database: KeeperDatabase,
  userId: string,
  options?: EventCountOptions,
): Promise<number> => {
  const { calendarIds } = await getSourcesForUser(database, userId);

  if (calendarIds.length === EMPTY_RESULT_COUNT) {
    return 0;
  }

  if (options) {
    return countEventsInWindow(database, userId, options);
  }

  return countAllEvents(database, calendarIds);
};

export { getEventCount };
export type { EventCountOptions };
