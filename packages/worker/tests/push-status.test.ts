import { env } from "cloudflare:workers";
import { createDatabase, createSecretCodec } from "@keeper.sh/database";
import { calendarAccountsTable, calendarsTable, oauthCredentialsTable, syncStatusTable } from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { pushDestinationCalendar } from "../src/push";

const database = createDatabase(env.DB);
const codec = createSecretCodec(env.ENCRYPTION_KEY);
const config = { database, encryptionKey: env.ENCRYPTION_KEY, googleClientId: "client-id", googleClientSecret: "client-secret" };

const seedDestination = async (nextAttemptAt: Date | null) => {
  const [credential] = await database.insert(oauthCredentialsTable).values({
    accessToken: codec.seal("access"),
    expiresAt: new Date(Date.now() + 3_600_000),
    provider: "google",
    refreshToken: codec.seal("refresh"),
  }).returning({ id: oauthCredentialsTable.id });
  const [account] = await database.insert(calendarAccountsTable).values({
    accountId: `google-${crypto.randomUUID()}`,
    authType: "oauth",
    oauthCredentialId: credential?.id ?? null,
    provider: "google",
  }).returning({ id: calendarAccountsTable.id });
  const [calendar] = await database.insert(calendarsTable).values({
    accountId: account?.id ?? "",
    calendarType: "oauth",
    capabilities: ["pull", "push"],
    externalCalendarId: "work@example.com",
    failureCount: 3,
    name: "Work",
    nextAttemptAt,
  }).returning({ id: calendarsTable.id });
  const calendarId = calendar?.id ?? "";
  await database.insert(syncStatusTable).values({ calendarId, lastError: "Invalid credentials", lastSyncedAt: new Date(0) });
  return calendarId;
};

const readStatus = async (calendarId: string) => {
  const [status] = await database.select().from(syncStatusTable).where(eq(syncStatusTable.calendarId, calendarId));
  return status;
};

describe("recording a destination push", () => {
  it("keeps the last error while the calendar is held back after failures", async () => {
    const calendarId = await seedDestination(new Date(Date.now() + 3_600_000));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await pushDestinationCalendar(config, calendarId);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readStatus(calendarId)).toMatchObject({ lastError: "Invalid credentials", lastSyncedAt: new Date(0) });
    fetchSpy.mockRestore();
  });

  it("clears the error once a push is allowed to run and nothing fails", async () => {
    const calendarId = await seedDestination(null);

    await pushDestinationCalendar(config, calendarId);

    const status = await readStatus(calendarId);
    expect(status?.lastError).toBeNull();
    expect(status?.lastSyncedAt?.getTime()).toBeGreaterThan(0);
  });
});
