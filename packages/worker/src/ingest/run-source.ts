import {
  RESET_CALENDAR_BACKOFF_STATE,
  buildCalendarBackoffState,
  createCoordinatedRefresher,
  createGoogleTokenRefresher,
  createRequiredSourceRanges,
  createSourceIngestionPlan,
  ensureValidToken,
  ingestSource,
  isTimeoutError,
} from "@keeper.sh/calendar";
import type { IngestionFetchEventsResult, RequiredSourceRanges, TokenState } from "@keeper.sh/calendar";
import { createCalDAVSourceFetcher, isCalDAVAuthenticationError } from "@keeper.sh/calendar/caldav";
import { resolveAuthMethod } from "@keeper.sh/calendar/digest-fetch";
import { createGoogleSourceFetcher } from "@keeper.sh/calendar/google";
import { createIcsSourceFetcher, interpretFullDayTimedEventsAsAllDay } from "@keeper.sh/calendar/ics";
import {
  INGEST_SOURCE_TIMEOUT_MS,
  INGEST_UNADJUDICABLE_REAUTHENTICATION_SOURCES,
  REAUTHENTICATION_SOURCE_INGEST,
} from "@keeper.sh/constants";
import {
  acquireLease,
  createRefreshLockStore,
  createSecretCodec,
  hasCapability,
  isDatabaseError,
} from "@keeper.sh/database";
import type { Database, SecretCodec } from "@keeper.sh/database";
import {
  caldavCredentialsTable,
  calendarAccountsTable,
  calendarsTable,
  oauthCredentialsTable,
  sourceDestinationMappingsTable,
} from "@keeper.sh/database/schema";
import { and, eq } from "drizzle-orm";
import { widelog } from "../telemetry";
import { IngestBaselineMovedError, createLeasedIngestionPersistence } from "./persistence";

/*
 * One source calendar, start to finish: take the run lease (skip if another run has
 * it), check backoff, fetch from the provider, persist under the source lease, then
 * record success or failure. Ported from upstream's cron ingest-sources job, minus the
 * fleet scheduling (lanes, weights, pending-signal draining) a single user never needs.
 */

const INGEST_RUN_LEASE_PREFIX = "ingest-run:";

interface IngestConfig {
  database: Database;
  encryptionKey: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

interface SourceIngestOutcome {
  status: "ingested" | "skipped" | "failed";
  // Destinations worth reconciling now because this source's events or authority changed.
  shouldPush: boolean;
}

const SKIPPED: SourceIngestOutcome = { shouldPush: false, status: "skipped" };

const readSource = async (database: Database, calendarId: string) => {
  const [row] = await database
    .select({
      accountId: calendarAccountsTable.id,
      authType: calendarAccountsTable.authType,
      caldavAuthMethod: caldavCredentialsTable.authMethod,
      caldavEncryptedPassword: caldavCredentialsTable.encryptedPassword,
      caldavServerUrl: caldavCredentialsTable.serverUrl,
      caldavUsername: caldavCredentialsTable.username,
      calendarUrl: calendarsTable.calendarUrl,
      excludeAvailabilities: calendarsTable.excludeAvailabilities,
      externalCalendarId: calendarsTable.externalCalendarId,
      failureCount: calendarsTable.ingestFailureCount,
      ingestFutureRange: calendarsTable.ingestFutureRange,
      ingestHistoricRange: calendarsTable.ingestHistoricRange,
      ingestSeq: calendarsTable.ingestSeq,
      ingestWindowEnd: calendarsTable.ingestWindowEnd,
      ingestWindowRecordedAt: calendarsTable.ingestWindowRecordedAt,
      ingestWindowStart: calendarsTable.ingestWindowStart,
      needsReauthentication: calendarAccountsTable.needsReauthentication,
      nextAttemptAt: calendarsTable.ingestNextAttemptAt,
      oauthAccessToken: oauthCredentialsTable.accessToken,
      oauthCredentialId: oauthCredentialsTable.id,
      oauthExpiresAt: oauthCredentialsTable.expiresAt,
      oauthRefreshToken: oauthCredentialsTable.refreshToken,
      provider: calendarAccountsTable.provider,
      reauthenticationSource: calendarAccountsTable.reauthenticationSource,
      syncToken: calendarsTable.syncToken,
      treatFullDayTimedEventsAsAllDay: calendarsTable.treatFullDayTimedEventsAsAllDay,
      url: calendarsTable.url,
    })
    .from(calendarsTable)
    .innerJoin(calendarAccountsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
    .leftJoin(caldavCredentialsTable, eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id))
    .leftJoin(oauthCredentialsTable, eq(calendarAccountsTable.oauthCredentialId, oauthCredentialsTable.id))
    .where(and(
      eq(calendarsTable.id, calendarId),
      eq(calendarsTable.disabled, false),
      hasCapability(calendarsTable.capabilities, "pull"),
    ))
    .limit(1);
  return row ?? null;
};

type StoredSource = NonNullable<Awaited<ReturnType<typeof readSource>>>;

const readRequiredRanges = async (database: Database, calendarId: string): Promise<RequiredSourceRanges> => {
  const destinations = await database
    .select({
      syncFutureRange: calendarsTable.syncFutureRange,
      syncHistoricRange: calendarsTable.syncHistoricRange,
    })
    .from(sourceDestinationMappingsTable)
    .innerJoin(calendarsTable, eq(sourceDestinationMappingsTable.destinationCalendarId, calendarsTable.id))
    .where(and(
      eq(sourceDestinationMappingsTable.sourceCalendarId, calendarId),
      eq(calendarsTable.disabled, false),
      hasCapability(calendarsTable.capabilities, "push"),
    ));
  return createRequiredSourceRanges(destinations);
};

const hasAuthorityChanged = (source: StoredSource, ranges: RequiredSourceRanges): boolean =>
  source.ingestWindowRecordedAt === null
  || source.ingestHistoricRange !== ranges.historicRange
  || source.ingestFutureRange !== ranges.futureRange;

/*
 * A Google sync token is only valid for the window it was issued against, and only once
 * that window has been recorded as complete coverage. Otherwise a full sync rebuilds it.
 */
const resolveGoogleSyncToken = (source: StoredSource, ranges: RequiredSourceRanges): string | null => {
  if (hasAuthorityChanged(source, ranges) || !source.ingestWindowStart || !source.ingestWindowEnd) {
    return null;
  }
  return source.syncToken;
};

const hasErrorFlag = (error: unknown, key: string): boolean =>
  error instanceof Error && (error as Error & Record<string, unknown>)[key] === true;

// The provider refused our credentials: a person has to reconnect, so retrying is pointless.
const isAuthenticationFailure = (error: unknown): boolean => {
  if (isTimeoutError(error) || isDatabaseError(error)) {
    return false;
  }
  return hasErrorFlag(error, "authRequired")
    || hasErrorFlag(error, "oauthReauthRequired")
    || isCalDAVAuthenticationError(error);
};

interface FetcherContext {
  calendarId: string;
  config: IngestConfig;
  ranges: RequiredSourceRanges;
  signal: AbortSignal;
  source: StoredSource;
  tokenCodec: SecretCodec;
}

type FetchEvents = () => Promise<IngestionFetchEventsResult>;

const SAFE_FETCH = { blockPrivateResolution: true } as const;

const resolveIcsFetcher = ({ calendarId, config, ranges, signal, source }: FetcherContext): FetchEvents | null => {
  if (!source.url) {
    return null;
  }
  const fetcher = createIcsSourceFetcher({
    calendarId,
    database: config.database,
    plan: createSourceIngestionPlan(ranges.historicRange, ranges.futureRange),
    safeFetchOptions: { ...SAFE_FETCH, signal },
    url: source.url,
  });
  return () => fetcher.fetchEvents({
    interpretEvents: (events, fetchContext) => interpretFullDayTimedEventsAsAllDay(events, {
      calendarTimeZone: fetchContext.calendarTimeZone,
      enabled: source.treatFullDayTimedEventsAsAllDay,
    }),
  });
};

const resolveCalDAVFetcher = ({ config, ranges, signal, source }: FetcherContext): FetchEvents | null => {
  if (!source.caldavServerUrl || !source.caldavUsername || !source.caldavEncryptedPassword) {
    return null;
  }
  const fetcher = createCalDAVSourceFetcher({
    authMethod: resolveAuthMethod(source.caldavAuthMethod ?? "basic"),
    calendarUrl: source.calendarUrl ?? source.caldavServerUrl,
    password: createSecretCodec(config.encryptionKey).open(source.caldavEncryptedPassword),
    plan: createSourceIngestionPlan(ranges.historicRange, ranges.futureRange),
    safeFetchOptions: { ...SAFE_FETCH, signal },
    serverUrl: source.caldavServerUrl,
    username: source.caldavUsername,
  });
  return () => fetcher.fetchEvents();
};

const resolveGoogleFetcher = async (context: FetcherContext): Promise<FetchEvents | null> => {
  const { calendarId, config, ranges, signal, source, tokenCodec } = context;
  if (
    source.provider !== "google"
    || !source.externalCalendarId
    || !source.oauthCredentialId
    || !source.oauthAccessToken
    || !source.oauthRefreshToken
    || !source.oauthExpiresAt
    || !config.googleClientId
    || !config.googleClientSecret
  ) {
    return null;
  }
  const tokenState: TokenState = {
    accessToken: tokenCodec.open(source.oauthAccessToken),
    accessTokenExpiresAt: source.oauthExpiresAt,
    refreshToken: tokenCodec.open(source.oauthRefreshToken),
  };
  const rawRefresh = createGoogleTokenRefresher({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  await ensureValidToken(tokenState, createCoordinatedRefresher({
    calendarAccountId: source.accountId,
    database: config.database,
    oauthCredentialId: source.oauthCredentialId,
    rawRefresh,
    refreshLockStore: createRefreshLockStore(config.database),
    tokenCodec,
  }));
  const fetcher = createGoogleSourceFetcher({
    accessToken: tokenState.accessToken,
    calendarId,
    externalCalendarId: source.externalCalendarId,
    plan: createSourceIngestionPlan(ranges.historicRange, ranges.futureRange),
    signal,
    syncToken: resolveGoogleSyncToken(source, ranges),
  });
  return () => fetcher.fetchEvents();
};

const resolveFetcher = (context: FetcherContext): Promise<FetchEvents | null> | FetchEvents | null => {
  if (context.source.authType === "oauth") {
    return resolveGoogleFetcher(context);
  }
  if (context.source.authType === "caldav") {
    return resolveCalDAVFetcher(context);
  }
  return resolveIcsFetcher(context);
};

const recordIngestSuccess = async (database: Database, calendarId: string, source: StoredSource) => {
  if (source.failureCount > 0) {
    await database
      .update(calendarsTable)
      .set({
        ingestFailureCount: RESET_CALENDAR_BACKOFF_STATE.failureCount,
        ingestLastFailureAt: RESET_CALENDAR_BACKOFF_STATE.lastFailureAt,
        ingestNextAttemptAt: RESET_CALENDAR_BACKOFF_STATE.nextAttemptAt,
      })
      .where(eq(calendarsTable.id, calendarId));
  }
  // A demand raised by a destination grant is not this ingest's to clear.
  const clearable = !INGEST_UNADJUDICABLE_REAUTHENTICATION_SOURCES.includes(
    source.reauthenticationSource ?? "",
  );
  if (source.needsReauthentication && clearable) {
    await database
      .update(calendarAccountsTable)
      .set({ needsReauthentication: false, reauthenticationSource: null })
      .where(eq(calendarAccountsTable.id, source.accountId));
  }
};

const recordIngestFailure = async (
  database: Database,
  calendarId: string,
  source: StoredSource,
  error: unknown,
) => {
  if (isAuthenticationFailure(error)) {
    await database
      .update(calendarAccountsTable)
      .set({ needsReauthentication: true, reauthenticationSource: REAUTHENTICATION_SOURCE_INGEST })
      .where(eq(calendarAccountsTable.id, source.accountId));
    return;
  }
  const backoff = buildCalendarBackoffState(source.failureCount);
  await database
    .update(calendarsTable)
    .set({
      ingestFailureCount: backoff.failureCount,
      ingestLastFailureAt: backoff.lastFailureAt,
      ingestNextAttemptAt: backoff.nextAttemptAt,
    })
    .where(eq(calendarsTable.id, calendarId));
};

const ingestSourceCalendar = async (
  config: IngestConfig,
  calendarId: string,
): Promise<SourceIngestOutcome> => {
  const { database } = config;
  const runLease = await acquireLease(database, `${INGEST_RUN_LEASE_PREFIX}${calendarId}`, INGEST_SOURCE_TIMEOUT_MS * 2);
  widelog.set("ingest.lock_acquired", runLease !== null);
  if (!runLease) {
    return SKIPPED;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Source ingest timed out")), INGEST_SOURCE_TIMEOUT_MS);
  try {
    const source = await readSource(database, calendarId);
    if (!source || (source.nextAttemptAt && source.nextAttemptAt > new Date())) {
      return SKIPPED;
    }
    widelog.set("provider.name", source.provider);
    widelog.set("provider.account_id", source.accountId);
    try {
      const ranges = await readRequiredRanges(database, calendarId);
      const fetchEvents = await resolveFetcher({
        calendarId,
        config,
        ranges,
        signal: controller.signal,
        source,
        tokenCodec: createSecretCodec(config.encryptionKey),
      });
      if (!fetchEvents) {
        return SKIPPED;
      }
      const result = await ingestSource({
        calendarId,
        fetchEvents,
        isCurrent: () => runLease.isHeld(),
        withPersistenceTransaction: createLeasedIngestionPersistence(database, calendarId, source.ingestSeq),
      });
      widelog.set("sync.events_added", result.eventsAdded);
      widelog.set("sync.events_removed", result.eventsRemoved);
      await recordIngestSuccess(database, calendarId, source);
      return {
        shouldPush: hasAuthorityChanged(source, ranges) || result.eventsAdded > 0 || result.eventsRemoved > 0,
        status: "ingested",
      };
    } catch (error) {
      // A newer ingest already won; nothing failed, this run just lost the race.
      if (error instanceof IngestBaselineMovedError) {
        return SKIPPED;
      }
      widelog.errorFields(error);
      await recordIngestFailure(database, calendarId, source, error);
      return { shouldPush: false, status: "failed" };
    }
  } finally {
    clearTimeout(timeout);
    await runLease.release();
  }
};

export { INGEST_RUN_LEASE_PREFIX, ingestSourceCalendar, isAuthenticationFailure };
export type { IngestConfig, SourceIngestOutcome };
