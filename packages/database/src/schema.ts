import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { isNotNull, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_FUTURE_SYNC_RANGE,
  DEFAULT_HISTORIC_SYNC_RANGE,
  SYNC_RANGE_DEFINITIONS,
} from "@keeper.sh/data-schemas";

/*
 * Ported from upstream's Postgres schema with the same table and column names, so engine
 * queries carry over unchanged. Postgres types map as: uuid -> text with a generated
 * UUID, timestamptz -> integer milliseconds, boolean -> integer 0/1, text[] -> JSON text.
 * There is no user table: Cloudflare Access is the only gate, and userId holds one
 * constant (see SINGLE_USER_ID) so the engine's per-user scoping stays intact.
 */

const SINGLE_USER_ID = "owner";

const DEFAULT_EVENT_COUNT = 0;

const SYNC_RANGE_SQL_VALUES = SYNC_RANGE_DEFINITIONS
  .map(({ value }) => `'${value}'`)
  .join(", ");

const id = () => text().notNull().primaryKey().$defaultFn(() => crypto.randomUUID());

const timestamp = () => integer({ mode: "timestamp_ms" });

const createdAt = () => timestamp().notNull().$defaultFn(() => new Date());

const updatedAt = () => timestamp()
  .notNull()
  .$defaultFn(() => new Date())
  .$onUpdate(() => new Date());

const boolean = () => integer({ mode: "boolean" });

const userId = () => text().notNull().default(SINGLE_USER_ID);

const textArray = () => text({ mode: "json" }).$type<string[]>();

const oauthCredentialsTable = sqliteTable(
  "oauth_credentials",
  {
    // Encrypted at rest with ENCRYPTION_KEY, like caldav_credentials.encryptedPassword.
    accessToken: text().notNull(),
    createdAt: createdAt(),
    email: text(),
    expiresAt: timestamp().notNull(),
    id: id(),
    needsReauthentication: boolean().notNull().default(false),
    provider: text().notNull(),
    refreshToken: text().notNull(),
    updatedAt: updatedAt(),
    userId: userId(),
  },
  (table) => [
    index("oauth_credentials_user_idx").on(table.userId),
    index("oauth_credentials_provider_idx").on(table.provider),
  ],
);

const caldavCredentialsTable = sqliteTable("caldav_credentials", {
  authMethod: text().notNull().default("basic"),
  createdAt: createdAt(),
  encryptedPassword: text().notNull(),
  id: id(),
  serverUrl: text().notNull(),
  updatedAt: updatedAt(),
  username: text().notNull(),
});

const calendarAccountsTable = sqliteTable(
  "calendar_accounts",
  {
    accountId: text(),
    authType: text().notNull(),
    caldavCredentialId: text().references(() => caldavCredentialsTable.id, {
      onDelete: "cascade",
    }),
    calendarsRefreshAttemptedAt: timestamp(),
    calendarsRefreshedAt: timestamp(),
    createdAt: createdAt(),
    displayName: text(),
    email: text(),
    id: id(),
    needsReauthentication: boolean().notNull().default(false),
    oauthCredentialId: text().references(() => oauthCredentialsTable.id, {
      onDelete: "cascade",
    }),
    provider: text().notNull(),
    reauthenticationSource: text(),
    updatedAt: updatedAt(),
    userId: userId(),
  },
  (table) => [
    index("calendar_accounts_user_idx").on(table.userId),
    index("calendar_accounts_provider_idx").on(table.provider),
    uniqueIndex("calendar_accounts_provider_account_idx").on(
      table.userId,
      table.provider,
      table.accountId,
    ),
  ],
);

const calendarsTable = sqliteTable(
  "calendars",
  {
    accountId: text()
      .notNull()
      .references(() => calendarAccountsTable.id, { onDelete: "cascade" }),
    calendarType: text().notNull(),
    calendarUrl: text(),
    createdAt: createdAt(),
    excludeAllDayEvents: boolean().notNull().default(false),
    excludeAvailabilities: textArray().notNull().default([]),
    excludeEventDescription: boolean().notNull().default(true),
    excludeEventLocation: boolean().notNull().default(true),
    excludeEventName: boolean().notNull().default(true),
    excludeFocusTime: boolean().notNull().default(false),
    excludeOutOfOffice: boolean().notNull().default(false),
    excludeTitleKeywords: textArray().notNull().default([]),
    treatFullDayTimedEventsAsAllDay: boolean().notNull().default(false),
    customEventName: text().notNull().default("{{calendar_name}}"),
    markEventsAsPrivate: boolean().notNull().default(false),
    disabled: boolean().notNull().default(false),
    failureCount: integer().notNull().default(0),
    lastFailureAt: timestamp(),
    nextAttemptAt: timestamp(),
    ingestFailureCount: integer().notNull().default(0),
    ingestLastFailureAt: timestamp(),
    ingestNextAttemptAt: timestamp(),
    ingestFutureRange: text().notNull().default(DEFAULT_FUTURE_SYNC_RANGE),
    ingestHistoricRange: text().notNull().default(DEFAULT_HISTORIC_SYNC_RANGE),
    ingestSeq: integer().notNull().default(0),
    ingestWindowEnd: timestamp(),
    ingestWindowRecordedAt: timestamp(),
    ingestWindowStart: timestamp(),
    providerMissingSince: timestamp(),
    externalCalendarId: text(),
    id: id(),
    capabilities: textArray().notNull().default(["pull"]),
    name: text().notNull(),
    originalName: text(),
    syncToken: text(),
    syncFutureRange: text().notNull().default(DEFAULT_FUTURE_SYNC_RANGE),
    syncHistoricRange: text().notNull().default(DEFAULT_HISTORIC_SYNC_RANGE),
    unavailableSince: timestamp(),
    updatedAt: updatedAt(),
    url: text(),
    userId: userId(),
  },
  (table) => [
    index("calendars_user_idx").on(table.userId),
    index("calendars_account_idx").on(table.accountId),
    index("calendars_type_idx").on(table.calendarType),
    /*
     * Range columns are plain text so a bad write is only caught when a reader
     * asserts it, far from the writer that caused it. Constraining them here
     * keeps a corrupt persisted value distinguishable from a corrupt read.
     */
    check(
      "calendars_sync_ranges_check",
      sql`"syncHistoricRange" IN (${sql.raw(SYNC_RANGE_SQL_VALUES)}) AND "syncFutureRange" IN (${sql.raw(SYNC_RANGE_SQL_VALUES)})`,
    ),
    check(
      "calendars_ingest_coverage_check",
      sql`"ingestHistoricRange" IN (${sql.raw(SYNC_RANGE_SQL_VALUES)}) AND "ingestFutureRange" IN (${sql.raw(SYNC_RANGE_SQL_VALUES)}) AND (("ingestWindowStart" IS NULL AND "ingestWindowEnd" IS NULL AND "ingestWindowRecordedAt" IS NULL) OR ("ingestWindowStart" IS NOT NULL AND "ingestWindowEnd" IS NOT NULL AND "ingestWindowRecordedAt" IS NOT NULL AND "ingestWindowStart" < "ingestWindowEnd"))`,
    ),
  ],
);

const calendarRemovalsTable = sqliteTable(
  "calendar_removals",
  {
    accountId: text()
      .notNull()
      .references(() => calendarAccountsTable.id, { onDelete: "cascade" }),
    calendarType: text().notNull(),
    calendarUrl: text(),
    createdAt: createdAt(),
    externalCalendarId: text(),
    id: id(),
    userId: userId(),
  },
  (table) => [
    index("calendar_removals_account_idx").on(table.accountId),
    uniqueIndex("calendar_removals_external_idx")
      .on(table.accountId, table.externalCalendarId)
      .where(isNotNull(table.externalCalendarId)),
    uniqueIndex("calendar_removals_url_idx")
      .on(table.accountId, table.calendarUrl)
      .where(isNotNull(table.calendarUrl)),
  ],
);

// Only the hash is kept: the engine never reads the feed text back.
const calendarSnapshotsTable = sqliteTable("calendar_snapshots", {
  calendarId: text()
    .notNull()
    .references(() => calendarsTable.id, { onDelete: "cascade" })
    .unique(),
  contentHash: text(),
  createdAt: createdAt(),
  id: id(),
});

const eventStatesTable = sqliteTable(
  "event_states",
  {
    availability: text(),
    calendarId: text()
      .notNull()
      .references(() => calendarsTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    description: text(),
    endTime: timestamp().notNull(),
    id: id(),
    location: text(),
    recurrenceRule: text(),
    exceptionDates: text(),
    recurrenceId: timestamp(),
    isAllDay: boolean(),
    sourceEventId: text(),
    sourceEventType: text(),
    sourceEventUid: text(),
    startTime: timestamp().notNull(),
    startTimeZone: text(),
    title: text(),
  },
  (table) => [
    index("event_states_start_time_idx").on(table.startTime),
    index("event_states_end_time_idx").on(table.endTime),
    index("event_states_calendar_idx").on(table.calendarId),
    uniqueIndex("event_states_source_event_idx")
      .on(table.calendarId, table.sourceEventId)
      .where(isNotNull(table.sourceEventId)),
    uniqueIndex("event_states_recurring_instance_idx")
      .on(table.calendarId, table.sourceEventUid, table.recurrenceId)
      .where(sql`${table.sourceEventId} is null and ${table.recurrenceId} is not null`),
    uniqueIndex("event_states_non_recurring_instance_idx")
      .on(table.calendarId, table.sourceEventUid, table.startTime, table.endTime)
      .where(sql`${table.sourceEventId} is null and ${table.recurrenceId} is null`),
  ],
);

const syncStatusTable = sqliteTable(
  "sync_status",
  {
    calendarId: text()
      .notNull()
      .references(() => calendarsTable.id, { onDelete: "cascade" }),
    id: id(),
    lastError: text(),
    lastSyncedAt: timestamp(),
    localEventCount: integer().notNull().default(DEFAULT_EVENT_COUNT),
    remoteEventCount: integer().notNull().default(DEFAULT_EVENT_COUNT),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("sync_status_calendar_idx").on(table.calendarId)],
);

const eventMappingsTable = sqliteTable(
  "event_mappings",
  {
    calendarId: text()
      .notNull()
      .references(() => calendarsTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    deleteIdentifier: text(),
    destinationEventUid: text().notNull(),
    endTime: timestamp().notNull(),
    // The mapping outlives its event state: that is how a deleted source event is retired.
    eventStateId: text()
      .references(() => eventStatesTable.id, { onDelete: "set null" }),
    id: id(),
    syncEventId: text(),
    syncEventHash: text(),
    sourceCalendarId: text(),
    startTime: timestamp().notNull(),
  },
  (table) => [
    uniqueIndex("event_mappings_sync_event_cal_idx")
      .on(table.calendarId, table.syncEventId)
      .where(isNotNull(table.syncEventId)),
    index("event_mappings_calendar_idx").on(table.calendarId),
    index("event_mappings_event_state_idx").on(table.eventStateId),
    index("event_mappings_source_calendar_idx").on(table.sourceCalendarId),
    check(
      "event_mappings_identity_check",
      sql`${table.eventStateId} is not null or ${table.syncEventId} is not null`,
    ),
    index("event_mappings_missing_sync_event_idx")
      .on(table.id)
      .where(isNull(table.syncEventId)),
    index("event_mappings_sync_hash_idx").on(table.syncEventHash),
  ],
);

const sourceDestinationMappingsTable = sqliteTable(
  "source_destination_mappings",
  {
    createdAt: createdAt(),
    destinationCalendarId: text()
      .notNull()
      .references(() => calendarsTable.id, { onDelete: "cascade" }),
    id: id(),
    sourceCalendarId: text()
      .notNull()
      .references(() => calendarsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("source_destination_mapping_idx").on(
      table.sourceCalendarId,
      table.destinationCalendarId,
    ),
    index("source_destination_mappings_source_idx").on(table.sourceCalendarId),
    index("source_destination_mappings_destination_idx").on(table.destinationCalendarId),
  ],
);

/*
 * Leases replace Postgres advisory locks and upstream's Redis sync lock.
 * A row is held while expiresAt is in the future; taking one is a single conditional
 * upsert checked on rows changed, so two consumers can never both win.
 */
const locksTable = sqliteTable("locks", {
  expiresAt: integer().notNull(),
  holder: text().notNull(),
  key: text().notNull().primaryKey(),
});

export {
  SINGLE_USER_ID,
  caldavCredentialsTable,
  calendarAccountsTable,
  calendarRemovalsTable,
  calendarSnapshotsTable,
  calendarsTable,
  eventMappingsTable,
  eventStatesTable,
  locksTable,
  oauthCredentialsTable,
  sourceDestinationMappingsTable,
  syncStatusTable,
};
