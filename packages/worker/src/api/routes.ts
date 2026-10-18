import {
  applyCalendarRediscoveryPlan,
  createCoordinatedRefresher,
  createGoogleTokenRefresher,
  ensureValidToken,
  getProvider,
  toDiscoveredCalDAVCalendars,
  toDiscoveredGoogleCalendars,
} from "@keeper.sh/calendar";
import type { TokenState } from "@keeper.sh/calendar";
import { CalDAVAuthenticationError, createCalDAVClient, invalidateCalendarDiscoveryCache } from "@keeper.sh/calendar/caldav";
import { listUserCalendars } from "@keeper.sh/calendar/google";
import { CalendarFetchError, pullRemoteCalendar } from "@keeper.sh/calendar/ics";
import { UrlSafetyError, validateUrlSafety } from "@keeper.sh/calendar/safe-fetch";
import { canExcludeAvailability, normalizeTitleKeywords, syncRangeSchema } from "@keeper.sh/data-schemas";
import { createCacheStore, createRefreshLockStore, createSecretCodec, hasCapability, withLeases } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";
import {
  SINGLE_USER_ID,
  caldavCredentialsTable,
  calendarAccountsTable,
  calendarRemovalsTable,
  calendarsTable,
  eventMappingsTable,
  oauthCredentialsTable,
  sourceDestinationMappingsTable,
  syncStatusTable,
} from "@keeper.sh/database/schema";
import { LOCK_PREFIX, createMappingMutationLockId } from "@keeper.sh/sync";
import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
import type { Env } from "../env";
import { completeGoogleConnect, startGoogleConnect } from "../http/google";
import { sendMessages } from "../messages";
import type { SyncMessage } from "../messages";
import { normalizeDateRange, parseDateRangeParams } from "./date-range";
import { withEventReadErrorHandling } from "./event-read-errors";
import { getEventCount } from "./get-event-count";
import { getEventsInRange } from "./get-events-in-range";
import { listSources } from "./list-sources";
import { withAccountDisplay, withProviderMetadata } from "./provider-display";
import { ErrorResponse } from "./responses";

/*
 * The upstream dashboard's API, answered by the Worker against D1. Shapes match what
 * applications/web expects from upstream's services/api; behaviour follows this fork's
 * rules: one user, no plans (everything is allowed), and nothing that could orphan a
 * mirror Keeper made (calendars still feeding a sync or owning copies are not removed).
 */

interface ApiContext {
  database: Database;
  encryptionKey: string;
  env: Env;
  origin: string;
  queue: Queue<SyncMessage>;
  request: Request;
  url: URL;
}

const REQUEST_TIMEOUT_MS = 15_000;
const SAFE_FETCH = { blockPrivateResolution: true, timeoutMs: REQUEST_TIMEOUT_MS } as const;
const MAPPING_MUTATION_LEASE = `${LOCK_PREFIX}${createMappingMutationLockId(SINGLE_USER_ID)}`;

const withMappingMutation = <TResult>(database: Database, work: () => Promise<TResult>): Promise<TResult> =>
  withLeases(database, [MAPPING_MUTATION_LEASE], { ttlMs: 30_000, waitMs: 10_000 }, work);

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty body; each route rejects what it needs and lacks.
  }
  return {};
};

const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

// ---- accounts ----

const ACCOUNT_COLUMNS = {
  accountIdentifier: calendarAccountsTable.accountId,
  authType: calendarAccountsTable.authType,
  calendarCount: count(calendarsTable.id),
  calendarsRefreshedAt: calendarAccountsTable.calendarsRefreshedAt,
  createdAt: calendarAccountsTable.createdAt,
  displayName: calendarAccountsTable.displayName,
  email: calendarAccountsTable.email,
  id: calendarAccountsTable.id,
  needsReauthentication: calendarAccountsTable.needsReauthentication,
  provider: calendarAccountsTable.provider,
};

const listAccounts = async ({ database }: ApiContext): Promise<Response> => {
  const accounts = await database
    .select(ACCOUNT_COLUMNS)
    .from(calendarAccountsTable)
    .leftJoin(calendarsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
    .groupBy(calendarAccountsTable.id)
    .orderBy(asc(calendarAccountsTable.createdAt));
  return json(accounts.map((account) => withAccountDisplay(account)));
};

const getAccount = async ({ database }: ApiContext, id: string): Promise<Response> => {
  const [account] = await database
    .select({
      ...ACCOUNT_COLUMNS,
      caldavServerUrl: caldavCredentialsTable.serverUrl,
      caldavUsername: caldavCredentialsTable.username,
    })
    .from(calendarAccountsTable)
    .leftJoin(calendarsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
    .leftJoin(caldavCredentialsTable, eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id))
    .where(eq(calendarAccountsTable.id, id))
    .groupBy(calendarAccountsTable.id, caldavCredentialsTable.id)
    .limit(1);
  if (!account) {
    return ErrorResponse.notFound("Account not found").toResponse();
  }
  return json(withAccountDisplay(account));
};

// A calendar still feeding a sync, or owning copies Keeper made, must not disappear.
const findCalendarsInUse = async (database: Database, calendarIds: string[]): Promise<boolean> => {
  if (calendarIds.length === 0) {
    return false;
  }
  const [mapped] = await database
    .select({ id: sourceDestinationMappingsTable.id })
    .from(sourceDestinationMappingsTable)
    .where(or(
      inArray(sourceDestinationMappingsTable.sourceCalendarId, calendarIds),
      inArray(sourceDestinationMappingsTable.destinationCalendarId, calendarIds),
    ))
    .limit(1);
  const [mirrored] = await database
    .select({ id: eventMappingsTable.id })
    .from(eventMappingsTable)
    .where(or(inArray(eventMappingsTable.calendarId, calendarIds), inArray(eventMappingsTable.sourceCalendarId, calendarIds)))
    .limit(1);
  return Boolean(mapped || mirrored);
};

const IN_USE_MESSAGE = "Turn off this calendar's syncs first and wait for its copies to clear, then remove it.";

const deleteAccount = ({ database }: ApiContext, id: string): Promise<Response> =>
  withMappingMutation(database, async () => {
    const calendars = await database.select({ id: calendarsTable.id }).from(calendarsTable)
      .where(eq(calendarsTable.accountId, id));
    if (await findCalendarsInUse(database, calendars.map((calendar) => calendar.id))) {
      return ErrorResponse.conflict(IN_USE_MESSAGE).toResponse();
    }
    const [account] = await database.delete(calendarAccountsTable).where(eq(calendarAccountsTable.id, id))
      .returning({
        caldavCredentialId: calendarAccountsTable.caldavCredentialId,
        oauthCredentialId: calendarAccountsTable.oauthCredentialId,
      });
    if (!account) {
      return ErrorResponse.notFound("Account not found").toResponse();
    }
    if (account.caldavCredentialId) {
      await database.delete(caldavCredentialsTable).where(eq(caldavCredentialsTable.id, account.caldavCredentialId));
    }
    if (account.oauthCredentialId) {
      await database.delete(oauthCredentialsTable).where(eq(oauthCredentialsTable.id, account.oauthCredentialId));
    }
    return json({ success: true });
  });

const discoverCalDAV = async (serverUrl: string, username: string, password: string) => {
  const client = createCalDAVClient({ credentials: { password, username }, serverUrl }, SAFE_FETCH);
  const calendars = await client.discoverCalendars();
  return { authMethod: client.getResolvedAuthMethod() ?? "basic", calendars };
};

const calDAVFailure = (error: unknown): Response => {
  if (error instanceof UrlSafetyError) {
    return ErrorResponse.badRequest("That server address is not allowed.").toResponse();
  }
  if (error instanceof CalDAVAuthenticationError) {
    return ErrorResponse.unauthorized("The server refused that username and password. For iCloud, use an app-specific password.").toResponse();
  }
  return ErrorResponse.badRequest("Keeper could not reach that CalDAV server.").toResponse();
};

// Reconnecting a CalDAV account replaces only its password, after proving the new one works.
const reconnectAccount = async (context: ApiContext, id: string): Promise<Response> => {
  const password = text(await readJson(context.request), "password");
  const [account] = await context.database
    .select({
      credentialId: caldavCredentialsTable.id,
      serverUrl: caldavCredentialsTable.serverUrl,
      username: caldavCredentialsTable.username,
    })
    .from(calendarAccountsTable)
    .innerJoin(caldavCredentialsTable, eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id))
    .where(eq(calendarAccountsTable.id, id))
    .limit(1);
  if (!account || !password) {
    return ErrorResponse.badRequest("A password is required").toResponse();
  }
  let authMethod: string;
  try {
    ({ authMethod } = await discoverCalDAV(account.serverUrl, account.username, password));
  } catch (error) {
    return calDAVFailure(error);
  }
  await context.database.update(caldavCredentialsTable)
    .set({ authMethod, encryptedPassword: createSecretCodec(context.encryptionKey).seal(password) })
    .where(eq(caldavCredentialsTable.id, account.credentialId));
  await context.database.update(calendarAccountsTable)
    .set({ needsReauthentication: false, reauthenticationSource: null })
    .where(eq(calendarAccountsTable.id, id));
  await invalidateCalendarDiscoveryCache(createCacheStore(context.database), id);
  return json({ success: true });
};

interface RefreshCounts {
  accounts: number;
  added: number;
  cooldownSeconds: number;
  failed: number;
  revived: number;
  unavailable: number;
}

interface StoredGoogleCredential {
  oauthAccessToken: string | null;
  oauthCredentialId: string | null;
  oauthExpiresAt: Date | null;
  oauthRefreshToken: string | null;
}

// Access tokens last an hour, so refresh through the same coordinated path ingest uses.
const googleAccessToken = async (context: ApiContext, accountId: string, credential: StoredGoogleCredential): Promise<string> => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = context.env;
  const { oauthAccessToken, oauthCredentialId, oauthExpiresAt, oauthRefreshToken } = credential;
  if (!oauthAccessToken || !oauthCredentialId || !oauthExpiresAt || !oauthRefreshToken || !clientId || !clientSecret) {
    throw new Error("google credentials incomplete");
  }
  const tokenCodec = createSecretCodec(context.encryptionKey);
  const tokenState: TokenState = {
    accessToken: tokenCodec.open(oauthAccessToken),
    accessTokenExpiresAt: oauthExpiresAt,
    refreshToken: tokenCodec.open(oauthRefreshToken),
  };
  await ensureValidToken(tokenState, createCoordinatedRefresher({
    calendarAccountId: accountId,
    database: context.database,
    oauthCredentialId,
    rawRefresh: createGoogleTokenRefresher({ clientId, clientSecret }),
    refreshLockStore: createRefreshLockStore(context.database),
    tokenCodec,
  }));
  return tokenState.accessToken;
};

const refreshOneAccount = async (context: ApiContext, accountId: string, counts: RefreshCounts): Promise<void> => {
  const [account] = await context.database
    .select({
      authType: calendarAccountsTable.authType,
      caldavPassword: caldavCredentialsTable.encryptedPassword,
      caldavServerUrl: caldavCredentialsTable.serverUrl,
      caldavUsername: caldavCredentialsTable.username,
      oauthAccessToken: oauthCredentialsTable.accessToken,
      oauthCredentialId: oauthCredentialsTable.id,
      oauthExpiresAt: oauthCredentialsTable.expiresAt,
      oauthRefreshToken: oauthCredentialsTable.refreshToken,
      provider: calendarAccountsTable.provider,
    })
    .from(calendarAccountsTable)
    .leftJoin(caldavCredentialsTable, eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id))
    .leftJoin(oauthCredentialsTable, eq(calendarAccountsTable.oauthCredentialId, oauthCredentialsTable.id))
    .where(eq(calendarAccountsTable.id, accountId))
    .limit(1);
  if (!account || account.authType === "none") {
    return;
  }
  counts.accounts += 1;
  const codec = createSecretCodec(context.encryptionKey);
  try {
    let discovered;
    let caldavServerHost: string | null = null;
    if (account.authType === "caldav" && account.caldavServerUrl && account.caldavUsername && account.caldavPassword) {
      const { calendars } = await discoverCalDAV(account.caldavServerUrl, account.caldavUsername, codec.open(account.caldavPassword));
      // The next sync reads the list this walk just stored rather than one cached before it.
      await invalidateCalendarDiscoveryCache(createCacheStore(context.database), accountId);
      discovered = toDiscoveredCalDAVCalendars(calendars);
      caldavServerHost = new URL(account.caldavServerUrl).host.toLowerCase();
    } else if (account.provider === "google") {
      discovered = toDiscoveredGoogleCalendars(await listUserCalendars(await googleAccessToken(context, accountId, account)));
    } else {
      return;
    }
    const plan = await applyCalendarRediscoveryPlan(context.database, {
      accountId,
      caldavServerHost,
      calendarType: account.authType === "caldav" ? "caldav" : "oauth",
      discovered,
      now: new Date(),
      userId: SINGLE_USER_ID,
    });
    counts.added += plan.inserted.length;
    counts.revived += plan.toRevive.length;
    counts.unavailable += plan.toMarkUnavailable.length;
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`calendar refresh failed for account ${accountId}: ${reason}`);
    counts.failed += 1;
  }
};

const emptyCounts = (): RefreshCounts => ({ accounts: 0, added: 0, cooldownSeconds: 0, failed: 0, revived: 0, unavailable: 0 });

// The account page words its result as imported / not found / back, so it gets its own shape.
const refreshAccount = async (context: ApiContext, id: string): Promise<Response> => {
  const [exists] = await context.database
    .select({ id: calendarAccountsTable.id })
    .from(calendarAccountsTable)
    .where(eq(calendarAccountsTable.id, id))
    .limit(1);
  if (!exists) {
    return ErrorResponse.notFound().toResponse();
  }
  // Feeds have no calendar list to rediscover, so they report nothing changed.
  const counts = emptyCounts();
  await refreshOneAccount(context, id, counts);
  if (counts.failed > 0) {
    return ErrorResponse.badRequest("Keeper could not reach this account. Reconnect it and try again.").toResponse();
  }
  return json({ imported: counts.added, missing: counts.unavailable, restored: counts.revived });
};

const refreshAllAccounts = async (context: ApiContext): Promise<Response> => {
  const counts = emptyCounts();
  const accounts = await context.database.select({ id: calendarAccountsTable.id }).from(calendarAccountsTable);
  for (const account of accounts) {
    await refreshOneAccount(context, account.id, counts);
  }
  return json(counts);
};

// ---- sources (calendars) ----

const readMappingIds = async (database: Database, column: "destination" | "source", calendarId: string): Promise<string[]> => {
  if (column === "destination") {
    const rows = await database.select({ id: sourceDestinationMappingsTable.destinationCalendarId })
      .from(sourceDestinationMappingsTable).where(eq(sourceDestinationMappingsTable.sourceCalendarId, calendarId));
    return rows.map((row) => row.id);
  }
  const rows = await database.select({ id: sourceDestinationMappingsTable.sourceCalendarId })
    .from(sourceDestinationMappingsTable).where(eq(sourceDestinationMappingsTable.destinationCalendarId, calendarId));
  return rows.map((row) => row.id);
};

const getSource = async ({ database }: ApiContext, id: string): Promise<Response> => {
  const [source] = await database
    .select({
      calendarType: calendarsTable.calendarType,
      calendarUrl: calendarsTable.calendarUrl,
      capabilities: calendarsTable.capabilities,
      createdAt: calendarsTable.createdAt,
      customEventName: calendarsTable.customEventName,
      disabled: calendarsTable.disabled,
      excludeAllDayEvents: calendarsTable.excludeAllDayEvents,
      excludeAvailabilities: calendarsTable.excludeAvailabilities,
      excludeEventDescription: calendarsTable.excludeEventDescription,
      excludeEventLocation: calendarsTable.excludeEventLocation,
      excludeEventName: calendarsTable.excludeEventName,
      excludeFocusTime: calendarsTable.excludeFocusTime,
      excludeOutOfOffice: calendarsTable.excludeOutOfOffice,
      excludeTitleKeywords: calendarsTable.excludeTitleKeywords,
      id: calendarsTable.id,
      ingestFailureCount: calendarsTable.ingestFailureCount,
      ingestLastFailureAt: calendarsTable.ingestLastFailureAt,
      markEventsAsPrivate: calendarsTable.markEventsAsPrivate,
      name: calendarsTable.name,
      originalName: calendarsTable.originalName,
      provider: calendarAccountsTable.provider,
      providerMissingSince: calendarsTable.providerMissingSince,
      syncFutureRange: calendarsTable.syncFutureRange,
      syncHistoricRange: calendarsTable.syncHistoricRange,
      treatFullDayTimedEventsAsAllDay: calendarsTable.treatFullDayTimedEventsAsAllDay,
      unavailableSince: calendarsTable.unavailableSince,
      updatedAt: calendarsTable.updatedAt,
      url: calendarsTable.url,
    })
    .from(calendarsTable)
    .innerJoin(calendarAccountsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
    .where(eq(calendarsTable.id, id))
    .limit(1);
  if (!source) {
    return ErrorResponse.notFound().toResponse();
  }
  const [destinationIds, sourceIds] = await Promise.all([
    readMappingIds(database, "destination", id),
    readMappingIds(database, "source", id),
  ]);
  return json({ ...withProviderMetadata(source), destinationIds, sourceIds });
};

const BOOLEAN_FIELDS = [
  "excludeAllDayEvents",
  "excludeEventDescription",
  "excludeEventLocation",
  "excludeEventName",
  "excludeFocusTime",
  "excludeOutOfOffice",
  "markEventsAsPrivate",
  "treatFullDayTimedEventsAsAllDay",
] as const;

const patchSource = async (context: ApiContext, id: string): Promise<Response> => {
  const body = await readJson(context.request);
  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (typeof body.customEventName === "string") {
    updates.customEventName = body.customEventName;
  }
  for (const range of ["syncHistoricRange", "syncFutureRange"] as const) {
    if (typeof body[range] === "string") {
      if (!syncRangeSchema.allows(body[range])) {
        return ErrorResponse.badRequest(`Unsupported ${range}`).toResponse();
      }
      updates[range] = body[range];
    }
  }
  if (Array.isArray(body.excludeTitleKeywords)) {
    updates.excludeTitleKeywords = normalizeTitleKeywords(body.excludeTitleKeywords.filter((value) => typeof value === "string"));
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === "boolean") {
      updates[field] = body[field];
    }
  }
  if (Array.isArray(body.excludeAvailabilities) || typeof body.excludeFreeEvents === "boolean") {
    const [source] = await context.database
      .select({ excludeAvailabilities: calendarsTable.excludeAvailabilities, provider: calendarAccountsTable.provider })
      .from(calendarsTable)
      .innerJoin(calendarAccountsTable, eq(calendarsTable.accountId, calendarAccountsTable.id))
      .where(eq(calendarsTable.id, id))
      .limit(1);
    if (!source) {
      return ErrorResponse.notFound().toResponse();
    }
    let requested = (Array.isArray(body.excludeAvailabilities) ? body.excludeAvailabilities : source.excludeAvailabilities)
      .filter((value): value is string => typeof value === "string");
    if (typeof body.excludeFreeEvents === "boolean") {
      requested = requested.filter((value) => value !== "free");
      if (body.excludeFreeEvents) {
        requested.push("free");
      }
    }
    const unsupported = requested.filter((availability) => !canExcludeAvailability(source.provider, availability));
    if (unsupported.length > 0) {
      return ErrorResponse.badRequest(`This calendar cannot exclude events by ${unsupported.join(", ")}.`).toResponse();
    }
    updates.excludeAvailabilities = [...new Set(requested)];
  }
  if (Object.keys(updates).length === 0) {
    return ErrorResponse.badRequest("No valid fields to update").toResponse();
  }
  const [updated] = await context.database.update(calendarsTable).set(updates)
    .where(eq(calendarsTable.id, id)).returning();
  if (!updated) {
    return ErrorResponse.notFound().toResponse();
  }
  // Settings change what is mirrored: reconcile every destination of this calendar now.
  const destinations = await readMappingIds(context.database, "destination", id);
  const pushes: SyncMessage[] = destinations.map((calendarId) => ({ calendarId, kind: "push" }));
  if (updated.capabilities.includes("push")) {
    pushes.push({ calendarId: id, kind: "push" });
  }
  await sendMessages(context.queue, pushes);
  return json(updated);
};

const deleteSource = ({ database }: ApiContext, id: string): Promise<Response> =>
  withMappingMutation(database, async () => {
    if (await findCalendarsInUse(database, [id])) {
      return ErrorResponse.conflict(IN_USE_MESSAGE).toResponse();
    }
    const [calendar] = await database.delete(calendarsTable).where(eq(calendarsTable.id, id)).returning();
    if (!calendar) {
      return ErrorResponse.notFound().toResponse();
    }
    // Remembered so a later calendar refresh does not bring it straight back.
    await database.insert(calendarRemovalsTable).values({
      accountId: calendar.accountId,
      calendarType: calendar.calendarType,
      calendarUrl: calendar.calendarUrl,
      externalCalendarId: calendar.externalCalendarId,
    }).onConflictDoNothing();
    return json({ success: true });
  });

const readCalendarIdsBody = async (request: Request): Promise<string[] | null> => {
  const body = await readJson(request);
  const ids = body.calendarIds;
  if (!Array.isArray(ids) || !ids.every((value) => typeof value === "string")) {
    return null;
  }
  return [...new Set(ids as string[])];
};

/*
 * Replaces the calendars mapped to one calendar, from either end. A removed mapping keeps
 * its event_mappings rows, which is what lets the next push retire those copies.
 */
const setMappings = async (context: ApiContext, id: string, end: "destinations" | "sources"): Promise<Response> => {
  const wanted = await readCalendarIdsBody(context.request);
  if (!wanted) {
    return ErrorResponse.badRequest("calendarIds array is required").toResponse();
  }
  if (wanted.includes(id)) {
    return ErrorResponse.badRequest("A calendar cannot sync into itself").toResponse();
  }
  const requiredOfThis = end === "destinations" ? "pull" : "push";
  const requiredOfOthers = end === "destinations" ? "push" : "pull";
  const [self] = await context.database.select({ id: calendarsTable.id }).from(calendarsTable)
    .where(and(eq(calendarsTable.id, id), hasCapability(calendarsTable.capabilities, requiredOfThis))).limit(1);
  if (!self) {
    return ErrorResponse.notFound().toResponse();
  }
  if (wanted.length > 0) {
    const valid = await context.database.select({ id: calendarsTable.id }).from(calendarsTable)
      .where(and(inArray(calendarsTable.id, wanted), hasCapability(calendarsTable.capabilities, requiredOfOthers)));
    if (valid.length !== wanted.length) {
      return ErrorResponse.badRequest(`Some ${end === "destinations" ? "destination" : "source"} calendars not found`).toResponse();
    }
  }
  const pairs = wanted.map((other) => end === "destinations"
    ? { destinationCalendarId: other, sourceCalendarId: id }
    : { destinationCalendarId: id, sourceCalendarId: other });
  const thisColumn = end === "destinations"
    ? sourceDestinationMappingsTable.sourceCalendarId
    : sourceDestinationMappingsTable.destinationCalendarId;

  const previous = await withMappingMutation(context.database, async () => {
    const existing = await context.database.select().from(sourceDestinationMappingsTable).where(eq(thisColumn, id));
    await context.database.delete(sourceDestinationMappingsTable).where(eq(thisColumn, id));
    if (pairs.length > 0) {
      await context.database.insert(sourceDestinationMappingsTable).values(pairs).onConflictDoNothing();
    }
    return existing;
  });

  const touched = [...previous, ...pairs];
  const messages: SyncMessage[] = [
    ...new Set(touched.map((pair) => pair.sourceCalendarId)),
  ].map((calendarId) => ({ calendarId, kind: "ingest" }));
  messages.push(...[...new Set(touched.map((pair) => pair.destinationCalendarId))]
    .map((calendarId): SyncMessage => ({ calendarId, kind: "push" })));
  await sendMessages(context.queue, messages);
  return json({ success: true });
};

// ---- connecting calendars ----

const feedFailure = (error: unknown): Response => {
  if (error instanceof UrlSafetyError) {
    return ErrorResponse.badRequest("That address is not allowed. Use an http or https link to a public server.").toResponse();
  }
  if (error instanceof CalendarFetchError) {
    return ErrorResponse.badRequest(error.message).toResponse();
  }
  return ErrorResponse.badRequest("Keeper could not download that feed. Check the address and try again.").toResponse();
};

const CALENDAR_NAME_PATTERN = /^X-WR-CALNAME:(.+)$/im;

// The feed is read once before it is saved, so a wrong link fails here, not later.
const createFeed = async (context: ApiContext): Promise<Response> => {
  const body = await readJson(context.request);
  const raw = text(body, "url");
  if (!raw) {
    return ErrorResponse.badRequest("A feed address is required").toResponse();
  }
  const url = raw.replace(/^webcals?:\/\//i, "https://");
  let ical: string;
  try {
    await validateUrlSafety(url, SAFE_FETCH);
    ({ ical } = await pullRemoteCalendar("ical", url, SAFE_FETCH));
  } catch (error) {
    return feedFailure(error);
  }
  const given = text(body, "name");
  const name = CALENDAR_NAME_PATTERN.exec(ical)?.[1]?.trim() || (given && given !== "iCal Feed" ? given : new URL(url).host);
  const [account] = await context.database.insert(calendarAccountsTable)
    .values({ accountId: url, authType: "none", displayName: name, provider: "ics" })
    .returning({ id: calendarAccountsTable.id });
  if (!account) {
    return ErrorResponse.internal().toResponse();
  }
  await context.database.insert(calendarsTable).values({
    accountId: account.id,
    calendarType: "ical",
    capabilities: ["pull"],
    name,
    originalName: name,
    url,
  });
  return json({ accountId: account.id }, 201);
};

const resolveCalDAVServer = (provider: string, given: string): string =>
  getProvider(provider)?.caldav?.serverUrl || given;

const discoverRoute = async (context: ApiContext): Promise<Response> => {
  const body = await readJson(context.request);
  const serverUrl = text(body, "serverUrl");
  const username = text(body, "username");
  const password = text(body, "password");
  if (!serverUrl || !username || !password) {
    return ErrorResponse.badRequest("Server, username and password are required").toResponse();
  }
  try {
    await validateUrlSafety(serverUrl, SAFE_FETCH);
    const { authMethod, calendars } = await discoverCalDAV(serverUrl, username, password);
    return json({ authMethod, calendars: calendars.map(({ displayName, url }) => ({ displayName, url })) });
  } catch (error) {
    return calDAVFailure(error);
  }
};

/*
 * Adds one discovered CalDAV calendar. The form calls this once per calendar right after
 * discovery proved the credentials, so they are stored as given; the account is shared.
 */
const createCalDAVSource = async (context: ApiContext): Promise<Response> => {
  const body = await readJson(context.request);
  const provider = text(body, "provider") || "caldav";
  const serverUrl = resolveCalDAVServer(provider, text(body, "serverUrl"));
  const username = text(body, "username");
  const password = text(body, "password");
  const calendarUrl = text(body, "calendarUrl");
  const name = text(body, "name") || "Calendar";
  const authMethod = text(body, "authMethod") === "digest" ? "digest" : "basic";
  if (!serverUrl || !username || !password || !calendarUrl) {
    return ErrorResponse.badRequest("Missing CalDAV details").toResponse();
  }
  try {
    await validateUrlSafety(serverUrl, SAFE_FETCH);
    await validateUrlSafety(calendarUrl, SAFE_FETCH);
  } catch (error) {
    return calDAVFailure(error);
  }
  const accountId = await withLeases(context.database, [`caldav-account:${provider}:${serverUrl}:${username}`], { ttlMs: 30_000, waitMs: 15_000 }, async () => {
    const [existing] = await context.database
      .select({ accountId: calendarAccountsTable.id, credentialId: caldavCredentialsTable.id })
      .from(calendarAccountsTable)
      .innerJoin(caldavCredentialsTable, eq(calendarAccountsTable.caldavCredentialId, caldavCredentialsTable.id))
      .where(and(
        eq(calendarAccountsTable.provider, provider),
        eq(caldavCredentialsTable.serverUrl, serverUrl),
        eq(caldavCredentialsTable.username, username),
      ))
      .limit(1);
    const encryptedPassword = createSecretCodec(context.encryptionKey).seal(password);
    if (existing) {
      await context.database.update(caldavCredentialsTable).set({ authMethod, encryptedPassword })
        .where(eq(caldavCredentialsTable.id, existing.credentialId));
      return existing.accountId;
    }
    const [credential] = await context.database.insert(caldavCredentialsTable)
      .values({ authMethod, encryptedPassword, serverUrl, username })
      .returning({ id: caldavCredentialsTable.id });
    const [account] = await context.database.insert(calendarAccountsTable).values({
      accountId: username,
      authType: "caldav",
      caldavCredentialId: credential?.id ?? null,
      displayName: username,
      email: username.includes("@") ? username : null,
      provider,
    }).returning({ id: calendarAccountsTable.id });
    return account?.id ?? null;
  });
  if (!accountId) {
    return ErrorResponse.internal().toResponse();
  }
  const [already] = await context.database.select({ id: calendarsTable.id }).from(calendarsTable)
    .where(and(eq(calendarsTable.accountId, accountId), eq(calendarsTable.calendarUrl, calendarUrl))).limit(1);
  if (!already) {
    await context.database.insert(calendarsTable).values({
      accountId,
      calendarType: "caldav",
      calendarUrl,
      capabilities: ["pull", "push"],
      name,
      originalName: name,
    });
  }
  return json({ accountId }, 201);
};

const googleContext = (context: ApiContext) => ({
  clientId: context.env.GOOGLE_CLIENT_ID,
  clientSecret: context.env.GOOGLE_CLIENT_SECRET,
  database: context.database,
  encryptionKey: context.encryptionKey,
  origin: context.origin,
});

const authorize = async (context: ApiContext): Promise<Response> => {
  if (context.url.searchParams.get("provider") !== "google") {
    return ErrorResponse.badRequest("Only Google can be connected with OAuth here").toResponse();
  }
  const target = await startGoogleConnect(googleContext(context));
  if (target.startsWith("https://")) {
    return Response.redirect(target, 302);
  }
  return Response.redirect(`${context.origin}/dashboard/connect?error=${target}`, 302);
};

const googleCallback = async (context: ApiContext): Promise<Response> => {
  const outcome = await completeGoogleConnect(googleContext(context), context.url);
  if (outcome === "connection-added" || outcome === "connection-reconnected") {
    return Response.redirect(`${context.origin}/dashboard`, 302);
  }
  return Response.redirect(`${context.origin}/dashboard/connect?error=${outcome}`, 302);
};

// ---- everything else the dashboard reads ----

const ENTITLEMENTS = {
  accounts: { current: 0, limit: null },
  canCustomizeIcalFeed: false,
  canUseEventFilters: true,
  feeds: { current: 0, limit: null },
  mappings: { current: 0, limit: null },
  plan: "pro",
  realtimeSync: false,
};

const events = (context: ApiContext): Promise<Response> => withEventReadErrorHandling(async () => {
  const { from, to } = parseDateRangeParams(context.url);
  const { end, start } = normalizeDateRange(from, to);
  return json(await getEventsInRange(context.database, SINGLE_USER_ID, { from: start, to: end }));
});

const syncStatus = async ({ database }: ApiContext): Promise<Response> => {
  const [latest] = await database.select({ lastSyncedAt: syncStatusTable.lastSyncedAt }).from(syncStatusTable)
    .orderBy(desc(syncStatusTable.lastSyncedAt)).limit(1);
  return json({ lastSyncedAt: latest?.lastSyncedAt?.toISOString() ?? null });
};

const routeApi = async (context: ApiContext): Promise<Response> => {
  const { request, url } = context;
  const segments = url.pathname.split("/").filter(Boolean).slice(1);
  const [resource, id, action] = segments;
  const {method} = request;

  if (resource === "accounts") {
    if (!id && method === "GET") {return listAccounts(context);}
    if (id === "refresh-calendars" && method === "POST") {return refreshAllAccounts(context);}
    if (id && !action && method === "GET") {return getAccount(context, id);}
    if (id && !action && method === "DELETE") {return deleteAccount(context, id);}
    if (id && action === "reconnect" && method === "POST") {return reconnectAccount(context, id);}
    if (id && action === "refresh" && method === "POST") {return refreshAccount(context, id);}
  }
  if (resource === "sources") {
    if (!id && method === "GET") {return json(await listSources(context.database, SINGLE_USER_ID));}
    if (id === "authorize" && method === "GET") {return authorize(context);}
    if (id === "callback" && action === "google" && method === "GET") {return googleCallback(context);}
    if (id === "caldav" && action === "discover" && method === "POST") {return discoverRoute(context);}
    if (id === "caldav" && !action && method === "POST") {return createCalDAVSource(context);}
    if (id && !action && method === "GET") {return getSource(context, id);}
    if (id && !action && method === "PATCH") {return patchSource(context, id);}
    if (id && !action && method === "DELETE") {return deleteSource(context, id);}
    if (id && (action === "destinations" || action === "sources")) {
      if (method === "GET") {
        const ids = await readMappingIds(context.database, action === "destinations" ? "destination" : "source", id);
        return json(action === "destinations" ? { destinationIds: ids } : { sourceIds: ids });
      }
      if (method === "PUT") {return setMappings(context, id, action);}
    }
  }
  if (resource === "ics" && method === "POST") {return createFeed(context);}
  if (resource === "events" && !id && method === "GET") {return events(context);}
  if (resource === "events" && id === "count" && method === "GET") {
    return json({ count: await getEventCount(context.database, SINGLE_USER_ID) });
  }
  if (resource === "entitlements" && method === "GET") {return json(ENTITLEMENTS);}
  if (resource === "sync" && id === "status" && method === "GET") {return syncStatus(context);}
  if (resource === "sync" && id === "now" && method === "POST") {
    const { planScheduledMessages } = await import("../schedule");
    await sendMessages(context.queue, await planScheduledMessages(context.database));
    return json({ success: true });
  }
  return ErrorResponse.notFound().toResponse();
};

export { routeApi };
export type { ApiContext };
