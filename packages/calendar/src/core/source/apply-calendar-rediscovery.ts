import { chunkForParameters, chunkRowsForInsert, runBatch, withLeases } from "@keeper.sh/database";
import type { Database, DatabaseBatchItem } from "@keeper.sh/database";
import { applySourceSyncDefaults } from "@keeper.sh/data-schemas";
import {
  calendarAccountsTable,
  caldavCredentialsTable,
  calendarRemovalsTable,
  calendarsTable,
} from "@keeper.sh/database/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  normalizeCalDAVCalendarKey,
  normalizeCalDAVServerHost,
} from "../../providers/caldav/shared/calendar-identity";
import {
  planCalendarRediscovery,
  toExistingCalendars,
  toRemovedIdentityKeys,
} from "./calendar-rediscovery";
import type {
  CalendarRediscoveryPlan,
  DiscoveredCalendar,
  RediscoveryCalendarType,
} from "./calendar-rediscovery";

/*
 * Upstream serialised rediscovery per user with pg_advisory_xact_lock; here it is a
 * lease. The reads, the plan and the batched writes all run under it.
 */
const ACCOUNT_REDISCOVERY_LEASE_PREFIX = "account-rediscovery:";
const ACCOUNT_REDISCOVERY_LEASE_TTL_MS = 60_000;
const ACCOUNT_REDISCOVERY_WAIT_MS = 30_000;
const SET_CLAUSE_PARAMETERS = 2;

interface InsertedCalendar {
  id: string;
  name: string;
}

interface CalendarRediscoveryApplyResult extends CalendarRediscoveryPlan {
  inserted: InsertedCalendar[];
}

interface CalendarRediscoveryApplyInput {
  accountId: string;
  userId: string;
  calendarType: RediscoveryCalendarType;
  caldavServerHost: string | null;
  discovered: DiscoveredCalendar[];
  now: Date;
}

const readExistingCalendars = async (
  transaction: Database,
  input: CalendarRediscoveryApplyInput,
) => {
  const rows = await transaction
    .select({
      calendarUrl: calendarsTable.calendarUrl,
      createdAt: calendarsTable.createdAt,
      externalCalendarId: calendarsTable.externalCalendarId,
      id: calendarsTable.id,
      unavailableSince: calendarsTable.unavailableSince,
    })
    .from(calendarsTable)
    .where(and(
      eq(calendarsTable.accountId, input.accountId),
      eq(calendarsTable.userId, input.userId),
      eq(calendarsTable.calendarType, input.calendarType),
    ));

  return toExistingCalendars(rows, input.calendarType);
};

const readRemovedKeys = async (
  transaction: Database,
  input: CalendarRediscoveryApplyInput,
): Promise<Set<string>> => {
  const rows = await transaction
    .select({
      calendarUrl: calendarRemovalsTable.calendarUrl,
      externalCalendarId: calendarRemovalsTable.externalCalendarId,
      id: calendarRemovalsTable.id,
    })
    .from(calendarRemovalsTable)
    .where(and(
      eq(calendarRemovalsTable.accountId, input.accountId),
      eq(calendarRemovalsTable.userId, input.userId),
      eq(calendarRemovalsTable.calendarType, input.calendarType),
    ));

  return toRemovedIdentityKeys(rows, input.calendarType);
};

/*
 * The host comparison stays in application code so it uses the same URL parser as the
 * CalDAV identity rule. A SQL pattern cannot reproduce punycode folding for
 * internationalized domains or bracketed IPv6 literals, and a host that parses
 * differently on each side silently disables the guard.
 */
const toBlockedKey = (
  row: { calendarUrl: string | null; serverUrl: string },
  caldavServerHost: string,
): string[] => {
  if (!row.calendarUrl || normalizeCalDAVServerHost(row.serverUrl) !== caldavServerHost) {
    return [];
  }
  return [normalizeCalDAVCalendarKey(row.calendarUrl)];
};

const readCrossAccountCalDAVKeys = async (
  transaction: Database,
  input: CalendarRediscoveryApplyInput,
): Promise<Set<string>> => {
  const { caldavServerHost } = input;
  if (!caldavServerHost) {
    return new Set<string>();
  }

  const rows = await transaction
    .select({
      calendarUrl: calendarsTable.calendarUrl,
      serverUrl: caldavCredentialsTable.serverUrl,
    })
    .from(calendarsTable)
    .innerJoin(calendarAccountsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
    .innerJoin(
      caldavCredentialsTable,
      eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id),
    )
    .where(and(
      eq(calendarsTable.userId, input.userId),
      ne(calendarsTable.accountId, input.accountId),
      eq(calendarAccountsTable.authType, "caldav"),
    ));

  return new Set(
    rows.flatMap((row) => toBlockedKey(row, caldavServerHost)),
  );
};

const resolveCapabilities = (writable: boolean): string[] => {
  if (writable) {
    return ["pull", "push"];
  }
  return ["pull"];
};

const resolveIdentityColumn = (
  calendar: DiscoveredCalendar,
): { calendarUrl: string | null } | { externalCalendarId: string } => {
  if (calendar.externalCalendarId === null) {
    return { calendarUrl: calendar.calendarUrl };
  }
  return { externalCalendarId: calendar.externalCalendarId };
};

const buildInsertRow = (
  calendar: DiscoveredCalendar,
  input: CalendarRediscoveryApplyInput,
) => applySourceSyncDefaults({
  accountId: input.accountId,
  calendarType: input.calendarType,
  capabilities: resolveCapabilities(calendar.writable),
  name: calendar.name,
  originalName: calendar.name,
  userId: input.userId,
  ...resolveIdentityColumn(calendar),
});

const buildPlanWrites = (
  database: Database,
  plan: CalendarRediscoveryPlan,
  input: CalendarRediscoveryApplyInput,
): { inserts: DatabaseBatchItem[]; updates: DatabaseBatchItem[] } => {
  const inserts = chunkRowsForInsert(
    calendarsTable,
    plan.toInsert.map((calendar) => buildInsertRow(calendar, input)),
  ).map((rows) => database
    .insert(calendarsTable)
    .values(rows)
    .returning({ id: calendarsTable.id, name: calendarsTable.name }));

  const updates: DatabaseBatchItem[] = [];
  // The SET clause binds unavailableSince and the updatedAt stamp beside the ids.
  for (const ids of chunkForParameters(plan.toRevive, 1, SET_CLAUSE_PARAMETERS)) {
    updates.push(database
      .update(calendarsTable)
      .set({ unavailableSince: null })
      .where(inArray(calendarsTable.id, ids)));
  }
  for (const ids of chunkForParameters(plan.toMarkUnavailable, 1, SET_CLAUSE_PARAMETERS)) {
    updates.push(database
      .update(calendarsTable)
      .set({ unavailableSince: input.now })
      .where(inArray(calendarsTable.id, ids)));
  }
  for (const retarget of plan.toRetargetUrl) {
    updates.push(database
      .update(calendarsTable)
      .set({ calendarUrl: retarget.calendarUrl })
      .where(eq(calendarsTable.id, retarget.id)));
  }
  updates.push(database
    .update(calendarAccountsTable)
    .set({ calendarsRefreshedAt: input.now })
    .where(eq(calendarAccountsTable.id, input.accountId)));

  return { inserts, updates };
};

const applyCalendarRediscoveryPlan = (
  database: Database,
  input: CalendarRediscoveryApplyInput,
): Promise<CalendarRediscoveryApplyResult> =>
  withLeases(
    database,
    [`${ACCOUNT_REDISCOVERY_LEASE_PREFIX}${input.userId}`],
    { ttlMs: ACCOUNT_REDISCOVERY_LEASE_TTL_MS, waitMs: ACCOUNT_REDISCOVERY_WAIT_MS },
    async () => {
      const existing = await readExistingCalendars(database, input);
      const blockedKeys = await readCrossAccountCalDAVKeys(database, input);
      const removedKeys = await readRemovedKeys(database, input);
      const plan = planCalendarRediscovery({
        blockedKeys,
        discovered: input.discovered,
        enumerationStartedAt: input.now,
        existing,
        removedKeys,
      });

      if (plan.suppressed) {
        return { ...plan, inserted: [] };
      }

      const { inserts, updates } = buildPlanWrites(database, plan, input);
      const results = await runBatch(database, [...inserts, ...updates]);
      const inserted = results
        .slice(0, inserts.length)
        .flatMap((rows) => rows as InsertedCalendar[]);

      return { ...plan, inserted };
    },
  );

const markCalendarRediscoveryAttempt = async (
  database: Database,
  accountId: string,
  now: Date,
): Promise<void> => {
  await database
    .update(calendarAccountsTable)
    .set({ calendarsRefreshAttemptedAt: now })
    .where(eq(calendarAccountsTable.id, accountId));
};

export {
  applyCalendarRediscoveryPlan,
  markCalendarRediscoveryAttempt,
};
export type { CalendarRediscoveryApplyInput, CalendarRediscoveryApplyResult, InsertedCalendar };
