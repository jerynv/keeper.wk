import { releaseLease, tryAcquireLease } from "@keeper.sh/database";
import {
  SINGLE_USER_ID,
  caldavCredentialsTable,
  calendarAccountsTable,
  calendarsTable,
  eventMappingsTable,
  eventStatesTable,
  sourceDestinationMappingsTable,
} from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applyCalendarRediscoveryPlan,
  markCalendarRediscoveryAttempt,
} from "../../../src/core/source/apply-calendar-rediscovery";
import type { DiscoveredCalendar } from "../../../src/core/source/calendar-rediscovery";
import { normalizeCalDAVServerHost } from "../../../src/providers/caldav/shared/calendar-identity";
import { testDatabase } from "../../support/d1";

const database = testDatabase();

const NOW = new Date("2026-08-12T10:00:00.000Z");
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const MARKED_AT = new Date("2026-07-01T00:00:00.000Z");

const PLAN_KEYS = [
  "crossAccountSkippedCount",
  "duplicateCount",
  "removedSkippedCount",
  "suppressed",
  "toInsert",
  "toMarkUnavailable",
  "toRetargetUrl",
  "toRevive",
  "unchangedCount",
];

const caldavDiscovery = (calendarUrl: string, name: string, writable = true): DiscoveredCalendar => ({
  calendarUrl,
  externalCalendarId: null,
  identityKey: new URL(calendarUrl).pathname.replace(/\/+$/u, ""),
  name,
  writable,
});

const oauthDiscovery = (externalCalendarId: string, name: string, writable = true): DiscoveredCalendar => ({
  calendarUrl: null,
  externalCalendarId,
  identityKey: externalCalendarId,
  name,
  writable,
});

const PROVIDER_BY_TYPE = { caldav: "caldav", oauth: "google" } as const;

const byNameOrder = (first: { name: string }, second: { name: string }): number =>
  first.name.localeCompare(second.name);

const seedAccount = async (calendarType: "caldav" | "oauth", serverUrl?: string): Promise<string> => {
  let caldavCredentialId: string | null = null;
  if (serverUrl) {
    const [credential] = await database
      .insert(caldavCredentialsTable)
      .values({ encryptedPassword: "sealed", serverUrl, username: "bob" })
      .returning();
    caldavCredentialId = credential?.id ?? null;
  }
  const [account] = await database
    .insert(calendarAccountsTable)
    .values({
      authType: calendarType,
      caldavCredentialId,
      provider: PROVIDER_BY_TYPE[calendarType],
    })
    .returning();
  return account?.id ?? "";
};

interface CalendarSeed {
  calendarUrl?: string | null;
  externalCalendarId?: string | null;
  id?: string;
  unavailableSince?: Date | null;
}

const seedCalendar = async (accountId: string, calendarType: string, seed: CalendarSeed) => {
  const [row] = await database
    .insert(calendarsTable)
    .values({
      accountId,
      calendarType,
      calendarUrl: seed.calendarUrl ?? null,
      createdAt: CREATED_AT,
      externalCalendarId: seed.externalCalendarId ?? null,
      id: seed.id ?? crypto.randomUUID(),
      name: "Seeded",
      unavailableSince: seed.unavailableSince ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("seed failed");
  }
  return row;
};

const calendarsOf = (accountId: string) =>
  database.select().from(calendarsTable).where(eq(calendarsTable.accountId, accountId));

const apply = (
  accountId: string,
  input: { calendarType: "caldav" | "oauth"; caldavServerHost?: string | null; discovered: DiscoveredCalendar[] },
) => applyCalendarRediscoveryPlan(database, {
  accountId,
  caldavServerHost: input.caldavServerHost ?? null,
  calendarType: input.calendarType,
  discovered: input.discovered,
  now: NOW,
  userId: SINGLE_USER_ID,
});

describe("applyCalendarRediscoveryPlan (D1)", () => {
  it("waits for a held account lease, then releases its own", async () => {
    const accountId = await seedAccount("oauth");
    const key = `account-rediscovery:${SINGLE_USER_ID}`;
    expect(await tryAcquireLease(database, key, "other-run", 60_000)).toBe(true);
    setTimeout(async () => {
      await releaseLease(database, key, "other-run");
    }, 100);

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Work")],
    });

    expect(result.inserted).toHaveLength(1);
    expect(await tryAcquireLease(database, key, "after", 60_000)).toBe(true);
    await releaseLease(database, key, "after");
  });

  it.each([
    ["an internationalized domain", "https://münchen.example/remote.php/dav"],
    ["a bracketed IPv6 literal", "https://[2001:db8::1]:8443/remote.php/dav"],
    ["a mixed-case host with a port", "https://Cloud.Example.com:8443/remote.php/dav"],
    ["a host with userinfo", "https://bob:secret@cloud.example.com/remote.php/dav"],
  ])("blocks a same-server cross-account CalDAV calendar behind %s", async (_label, serverUrl) => {
    const otherAccount = await seedAccount("caldav", serverUrl);
    await seedCalendar(otherAccount, "caldav", { calendarUrl: "https://host.invalid/dav/bob/work" });
    const accountId = await seedAccount("caldav", serverUrl);

    const result = await apply(accountId, {
      caldavServerHost: normalizeCalDAVServerHost(serverUrl),
      calendarType: "caldav",
      discovered: [caldavDiscovery("https://host.invalid/dav/bob/work/", "Work")],
    });

    expect(result.crossAccountSkippedCount).toBe(1);
    expect(await calendarsOf(accountId)).toEqual([]);
  });

  it("never blocks a calendar path served by a genuinely different host", async () => {
    const otherAccount = await seedAccount("caldav", "https://other.example/remote.php/dav");
    await seedCalendar(otherAccount, "caldav", {
      calendarUrl: "https://other.example/remote.php/dav/calendars/bob/work",
    });
    const accountId = await seedAccount("caldav", "https://cloud.example.com/remote.php/dav");

    const result = await apply(accountId, {
      caldavServerHost: normalizeCalDAVServerHost("https://cloud.example.com/remote.php/dav"),
      calendarType: "caldav",
      discovered: [caldavDiscovery("https://cloud.example.com/remote.php/dav/calendars/bob/work", "Work")],
    });

    expect(result.crossAccountSkippedCount).toBe(0);
    expect(await calendarsOf(accountId)).toHaveLength(1);
  });

  it("adds newly discovered calendars with provider-derived capabilities and returns their stored ids", async () => {
    const accountId = await seedAccount("oauth");

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [
        oauthDiscovery("external-1", "Writable", true),
        oauthDiscovery("external-2", "Read Only", false),
      ],
    });

    const stored = await calendarsOf(accountId);
    const byName = new Map(stored.map((row) => [row.name, row]));
    expect(byName.get("Writable")?.capabilities).toEqual(["pull", "push"]);
    expect(byName.get("Read Only")?.capabilities).toEqual(["pull"]);
    for (const row of stored) {
      expect(row.unavailableSince).toBeNull();
      expect(row.originalName).toBe(row.name);
      expect(row.userId).toBe(SINGLE_USER_ID);
      expect(row.externalCalendarId).not.toBeNull();
      expect(row.calendarUrl).toBeNull();
    }
    expect(result.inserted.toSorted(byNameOrder))
      .toEqual(stored.map(({ id, name }) => ({ id, name })).toSorted(byNameOrder));
    expect(JSON.stringify(result.toInsert)).not.toContain(stored[0]?.id ?? "unreachable");
  });

  it("inserts nothing and reports nothing inserted when there is nothing new", async () => {
    const accountId = await seedAccount("oauth");
    await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Work")],
    });

    expect(result.inserted).toEqual([]);
    expect(await calendarsOf(accountId)).toHaveLength(1);
  });

  it("inserts CalDAV calendars against calendarUrl rather than an external id", async () => {
    // D1 state persists across this file's tests, so this path is one no other test claims.
    const accountId = await seedAccount("caldav", "https://cloud.example.com/dav");

    await apply(accountId, {
      caldavServerHost: "cloud.example.com",
      calendarType: "caldav",
      discovered: [caldavDiscovery("https://cloud.example.com/dav/bob/inbox/", "Inbox")],
    });

    const [row] = await calendarsOf(accountId);
    expect(row?.calendarUrl).toBe("https://cloud.example.com/dav/bob/inbox/");
    expect(row?.externalCalendarId).toBeNull();
    expect(row?.calendarType).toBe("caldav");
  });

  it("never inserts a CalDAV calendar already connected under another account on the same server", async () => {
    const otherAccount = await seedAccount("caldav", "https://cloud.example.com/dav");
    await seedCalendar(otherAccount, "caldav", { calendarUrl: "https://cloud.example.com/dav/bob/work" });
    const accountId = await seedAccount("caldav", "https://cloud.example.com/dav");

    const result = await apply(accountId, {
      caldavServerHost: "cloud.example.com",
      calendarType: "caldav",
      discovered: [
        caldavDiscovery("https://cloud.example.com/dav/bob/work/", "Work"),
        caldavDiscovery("https://cloud.example.com/dav/bob/private/", "Private"),
      ],
    });

    expect(result.crossAccountSkippedCount).toBe(1);
    const stored = await calendarsOf(accountId);
    expect(stored.map((row) => row.calendarUrl)).toEqual(["https://cloud.example.com/dav/bob/private/"]);
  });

  it("marks a vanished calendar and preserves its row, its sync mappings and its mirrors", async () => {
    const accountId = await seedAccount("oauth");
    await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });
    const vanished = await seedCalendar(accountId, "oauth", { externalCalendarId: "external-2" });
    const destination = await seedCalendar(accountId, "oauth", { externalCalendarId: "external-dest" });
    await database.insert(sourceDestinationMappingsTable).values({
      destinationCalendarId: destination.id,
      sourceCalendarId: vanished.id,
    });
    await database.insert(eventStatesTable).values({
      calendarId: vanished.id,
      endTime: NOW,
      sourceEventUid: "uid-1",
      startTime: CREATED_AT,
    });
    await database.insert(eventMappingsTable).values({
      calendarId: destination.id,
      destinationEventUid: "abc@keeper.sh",
      endTime: NOW,
      sourceCalendarId: vanished.id,
      startTime: CREATED_AT,
      syncEventId: "sync-1",
    });

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Kept"), oauthDiscovery("external-dest", "Dest")],
    });

    expect(result.toMarkUnavailable).toEqual([vanished.id]);
    const [stored] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, vanished.id));
    expect(stored?.unavailableSince).toEqual(NOW);
    expect(await database.select().from(sourceDestinationMappingsTable)
      .where(eq(sourceDestinationMappingsTable.sourceCalendarId, vanished.id))).toHaveLength(1);
    expect(await database.select().from(eventStatesTable)
      .where(eq(eventStatesTable.calendarId, vanished.id))).toHaveLength(1);
    expect(await database.select().from(eventMappingsTable)
      .where(eq(eventMappingsTable.sourceCalendarId, vanished.id))).toHaveLength(1);
  });

  it("ignores the identity-less destination row an OAuth account carries", async () => {
    const accountId = await seedAccount("oauth");
    await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });
    const identityLess = await seedCalendar(accountId, "oauth", {});

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Work")],
    });

    expect(result.toMarkUnavailable).toEqual([]);
    expect(result.toInsert).toEqual([]);
    expect(result.unchangedCount).toBe(1);
    const [row] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, identityLess.id));
    expect(row?.unavailableSince).toBeNull();
  });

  it("reinstates a reappearing calendar by clearing only its unavailability", async () => {
    const accountId = await seedAccount("oauth");
    const marked = await seedCalendar(accountId, "oauth", {
      externalCalendarId: "external-1",
      unavailableSince: MARKED_AT,
    });
    await database
      .update(calendarsTable)
      .set({ capabilities: ["pull", "push"], disabled: true, failureCount: 3, name: "Kept name" })
      .where(eq(calendarsTable.id, marked.id));

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Back")],
    });

    expect(result.toRevive).toEqual([marked.id]);
    const [row] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, marked.id));
    expect(row?.unavailableSince).toBeNull();
    expect(row?.disabled).toBe(true);
    expect(row?.failureCount).toBe(3);
    expect(row?.name).toBe("Kept name");
    expect(row?.capabilities).toEqual(["pull", "push"]);
  });

  it("advances the success cursor but never the scheduling attempt cursor", async () => {
    const accountId = await seedAccount("oauth");
    await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Kept"), oauthDiscovery("external-2", "New")],
    });

    expect(result.suppressed).toBe(false);
    const [account] = await database.select().from(calendarAccountsTable).where(eq(calendarAccountsTable.id, accountId));
    expect(account?.calendarsRefreshedAt).toEqual(NOW);
    expect(account?.calendarsRefreshAttemptedAt).toBeNull();
  });

  it("writes nothing at all when a successful enumeration comes back empty", async () => {
    const accountId = await seedAccount("oauth");
    const existing = await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });

    const result = await apply(accountId, { calendarType: "oauth", discovered: [] });

    expect(result.suppressed).toBe(true);
    expect(result.toMarkUnavailable).toEqual([]);
    const [row] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, existing.id));
    expect(row?.unavailableSince).toBeNull();
    const [account] = await database.select().from(calendarAccountsTable).where(eq(calendarAccountsTable.id, accountId));
    expect(account?.calendarsRefreshedAt).toBeNull();
  });

  it("returns the whole plan alongside the inserted rows", async () => {
    const accountId = await seedAccount("oauth");
    await seedCalendar(accountId, "oauth", { externalCalendarId: "external-1" });

    const result = await apply(accountId, {
      calendarType: "oauth",
      discovered: [oauthDiscovery("external-1", "Kept"), oauthDiscovery("external-2", "New")],
    });

    expect(Object.keys(result).toSorted()).toEqual([...PLAN_KEYS, "inserted"].toSorted());
  });
});

describe("markCalendarRediscoveryAttempt (D1)", () => {
  it("stamps only the attempt cursor", async () => {
    const accountId = await seedAccount("oauth");

    await markCalendarRediscoveryAttempt(database, accountId, NOW);

    const [account] = await database.select().from(calendarAccountsTable).where(eq(calendarAccountsTable.id, accountId));
    expect(account?.calendarsRefreshAttemptedAt).toEqual(NOW);
    expect(account?.calendarsRefreshedAt).toBeNull();
  });
});
