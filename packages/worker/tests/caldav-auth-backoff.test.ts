import { env } from "cloudflare:workers";
import { createDatabase, createSecretCodec } from "@keeper.sh/database";
import {
  caldavCredentialsTable,
  calendarAccountsTable,
  calendarsTable,
  sourceDestinationMappingsTable,
} from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestSourceCalendar } from "../src/ingest/run-source";

const database = createDatabase(env.DB);
const config = { database, encryptionKey: env.ENCRYPTION_KEY };
const SERVER = "https://caldav.icloud.com";

const seedCalDAVSource = async () => {
  const [credential] = await database.insert(caldavCredentialsTable).values({
    encryptedPassword: createSecretCodec(env.ENCRYPTION_KEY).seal("revoked-app-password"),
    serverUrl: SERVER,
    username: "jeryn@icloud.com",
  }).returning({ id: caldavCredentialsTable.id });
  const [account] = await database.insert(calendarAccountsTable).values({
    authType: "caldav",
    caldavCredentialId: credential?.id ?? null,
    provider: "icloud",
  }).returning({ id: calendarAccountsTable.id });
  const [source] = await database.insert(calendarsTable).values({
    accountId: account?.id ?? "",
    calendarType: "caldav",
    calendarUrl: `${SERVER}/123/calendars/school/`,
    capabilities: ["pull", "push"],
    name: "School",
  }).returning({ id: calendarsTable.id });
  const [destination] = await database.insert(calendarsTable).values({
    accountId: account?.id ?? "",
    calendarType: "caldav",
    capabilities: ["pull", "push"],
    name: "Home",
  }).returning({ id: calendarsTable.id });
  if (!account || !source || !destination) {
    throw new Error("seed failed");
  }
  await database.insert(sourceDestinationMappingsTable).values({
    destinationCalendarId: destination.id,
    sourceCalendarId: source.id,
  });
  return { accountId: account.id, sourceId: source.id };
};

// What iCloud sends once it has stopped accepting a password: 401, no challenge, no body.
const refuseEverything = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(null, { status: 401 })));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a CalDAV source whose password is refused", () => {
  it("asks for a reconnect and stops asking the server every minute", async () => {
    const { accountId, sourceId } = await seedCalDAVSource();
    const fetchSpy = refuseEverything();

    expect(await ingestSourceCalendar(config, sourceId)).toEqual({ shouldPush: false, status: "failed" });

    const [account] = await database.select().from(calendarAccountsTable).where(eq(calendarAccountsTable.id, accountId));
    expect(account?.needsReauthentication).toBe(true);
    const [calendar] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, sourceId));
    expect(calendar?.ingestFailureCount).toBe(1);
    expect(calendar?.ingestNextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    const callsAfterFirstRun = fetchSpy.mock.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0);
    expect(await ingestSourceCalendar(config, sourceId)).toEqual({ shouldPush: false, status: "skipped" });
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirstRun);
  });
});
