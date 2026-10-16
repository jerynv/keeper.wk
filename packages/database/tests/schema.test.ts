import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import {
  classifyDatabaseError,
  createDatabase,
  getDatabaseErrorDetails,
  hasCapability,
  isDatabaseError,
  resolveDatabaseErrorClassification,
} from "../src";
import {
  SINGLE_USER_ID,
  calendarAccountsTable,
  calendarsTable,
  eventMappingsTable,
  eventStatesTable,
} from "../src/schema";

const database = createDatabase(env.DB);

const seedCalendar = async (capabilities: string[] = ["pull"]) => {
  const [account] = await database
    .insert(calendarAccountsTable)
    .values({ authType: "none", provider: "ics" })
    .returning();
  const [calendar] = await database
    .insert(calendarsTable)
    .values({
      accountId: account?.id ?? "",
      calendarType: "ics",
      capabilities,
      name: "Test",
    })
    .returning();
  if (!account || !calendar) {
    throw new Error("seed failed");
  }
  return { account, calendar };
};

const START = new Date("2026-11-02T15:00:00.000Z");
const END = new Date("2026-11-02T16:00:00.000Z");

describe("D1 schema", () => {
  it("round-trips dates, booleans and JSON arrays, and fills defaults", async () => {
    const { calendar } = await seedCalendar(["pull", "push"]);
    const [row] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, calendar.id));

    expect(row?.userId).toBe(SINGLE_USER_ID);
    expect(row?.capabilities).toEqual(["pull", "push"]);
    expect(row?.excludeEventName).toBe(true);
    expect(row?.disabled).toBe(false);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.syncFutureRange).toBe("2_years");
  });

  it("filters by capability through json_each", async () => {
    const { calendar: pushable } = await seedCalendar(["pull", "push"]);
    const { calendar: pullOnly } = await seedCalendar(["pull"]);

    const rows = await database
      .select({ id: calendarsTable.id })
      .from(calendarsTable)
      .where(hasCapability(calendarsTable.capabilities, "push"));
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(pushable.id);
    expect(ids).not.toContain(pullOnly.id);
  });

  it("keeps a mapping row after its event state is deleted", async () => {
    // This is how a deleted source event's mirror gets retired: the mapping outlives it.
    const { calendar: source } = await seedCalendar();
    const { calendar: destination } = await seedCalendar(["pull", "push"]);
    const [state] = await database
      .insert(eventStatesTable)
      .values({ calendarId: source.id, endTime: END, sourceEventUid: "uid-1", startTime: START })
      .returning();
    await database.insert(eventMappingsTable).values({
      calendarId: destination.id,
      destinationEventUid: "abc@keeper.sh",
      endTime: END,
      eventStateId: state?.id,
      sourceCalendarId: source.id,
      startTime: START,
      syncEventId: state?.id,
    });

    await database.delete(eventStatesTable).where(eq(eventStatesTable.id, state?.id ?? ""));

    const mappings = await database
      .select()
      .from(eventMappingsTable)
      .where(eq(eventMappingsTable.calendarId, destination.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.eventStateId).toBeNull();
    expect(mappings[0]?.syncEventId).toBe(state?.id);
  });

  it("cascades a deleted calendar to its event states and mappings", async () => {
    const { account, calendar } = await seedCalendar(["pull", "push"]);
    await database.insert(eventStatesTable).values({
      calendarId: calendar.id,
      endTime: END,
      sourceEventUid: "uid-1",
      startTime: START,
    });
    await database.insert(eventMappingsTable).values({
      calendarId: calendar.id,
      destinationEventUid: "abc@keeper.sh",
      endTime: END,
      startTime: START,
      syncEventId: "sync-1",
    });

    await database.delete(calendarAccountsTable).where(eq(calendarAccountsTable.id, account.id));

    expect(await database.select().from(eventStatesTable).where(eq(eventStatesTable.calendarId, calendar.id))).toEqual([]);
    expect(await database.select().from(eventMappingsTable).where(eq(eventMappingsTable.calendarId, calendar.id))).toEqual([]);
  });

  it("enforces the partial unique index on recurring instances only", async () => {
    const { calendar } = await seedCalendar();
    const instance = {
      calendarId: calendar.id,
      endTime: END,
      recurrenceId: START,
      sourceEventUid: "series-1",
      startTime: START,
    };
    await database.insert(eventStatesTable).values(instance);

    await expect(database.insert(eventStatesTable).values(instance)).rejects.toThrow();
    // A row with a sourceEventId sits outside that index's predicate.
    await database.insert(eventStatesTable).values({ ...instance, sourceEventId: "provider-id" });
    const rows = await database
      .select()
      .from(eventStatesTable)
      .where(and(eq(eventStatesTable.calendarId, calendar.id), eq(eventStatesTable.sourceEventUid, "series-1")));
    expect(rows).toHaveLength(2);
  });

  it("rejects an unknown sync range and a mapping with no identity", async () => {
    const { account } = await seedCalendar();
    await expect(database.insert(calendarsTable).values({
      accountId: account.id,
      calendarType: "ics",
      name: "Bad",
      syncFutureRange: "forever",
    })).rejects.toThrow();

    const { calendar } = await seedCalendar();
    await expect(database.insert(eventMappingsTable).values({
      calendarId: calendar.id,
      destinationEventUid: "abc@keeper.sh",
      endTime: END,
      startTime: START,
    })).rejects.toThrow();
  });
});

describe("D1 error classification", () => {
  it("recognises a real D1 constraint failure and keeps bound values out of the details", async () => {
    const { calendar } = await seedCalendar();
    const mapping = {
      calendarId: calendar.id,
      destinationEventUid: "secret-title@keeper.sh",
      endTime: END,
      startTime: START,
      syncEventId: "sync-dup",
    };
    await database.insert(eventMappingsTable).values(mapping);

    const failure = await database.insert(eventMappingsTable).values(mapping).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isDatabaseError(failure)).toBe(true);
    expect(classifyDatabaseError(failure)).toBeNull();
    expect(resolveDatabaseErrorClassification(failure)).toEqual({ slug: "db-query-failed", sqlState: null });
    const details = getDatabaseErrorDetails(failure);
    expect(details?.detail).toBe("UNIQUE");
    expect(details?.constraint).toContain("event_mappings.calendarId");
    expect(details?.message).not.toContain("secret-title");
  });

  it("recognises drizzle's query wrapper even when its cause is not a D1 error", () => {
    // The wrapper's message inlines bound values, so it must never be read as anything else.
    const wrapped = new DrizzleQueryError("insert into event_states ...", ["authentication failed"], new Error("boom"));
    expect(isDatabaseError(wrapped)).toBe(true);
    expect(getDatabaseErrorDetails(wrapped)).toBeNull();
  });

  it("does not treat an ordinary error as a database error", () => {
    const error = new Error("404 Not Found");
    expect(isDatabaseError(error)).toBe(false);
    expect(getDatabaseErrorDetails(error)).toBeNull();
    expect(resolveDatabaseErrorClassification(error)).toBeNull();
  });

  it("classifies D1's documented transient failures as retryable", () => {
    const wrapped = new Error("Failed query", { cause: new Error("D1_ERROR: Network connection lost.") });
    expect(classifyDatabaseError(wrapped)).toEqual({ slug: "db-connection-lost", sqlState: null });
  });
});
