import { D1_MAX_BOUND_PARAMETERS } from "@keeper.sh/database";
import { eventStatesTable } from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { EventStateInsertRow } from "../../../src/core/source/write-event-states";
import {
  buildEventStateInsertRow,
  buildEventStateInsertStatements,
  insertEventStatesWithConflictResolution,
} from "../../../src/core/source/write-event-states";
import { seedCalendar, testDatabase } from "../../support/d1";

const database = testDatabase();

const readStates = (calendarId: string) =>
  database.select().from(eventStatesTable).where(eq(eventStatesTable.calendarId, calendarId));

describe("insertEventStatesWithConflictResolution (D1)", () => {
  it("persists recurrence metadata", () => {
    const recurrenceId = new Date("2026-03-05T10:00:00.000Z");
    const row = buildEventStateInsertRow("calendar-1", {
      endTime: new Date("2026-03-12T11:00:00.000Z"),
      exceptionDates: [{ date: new Date("2026-03-19T10:00:00.000Z") }],
      recurrenceId,
      recurrenceRule: { frequency: "WEEKLY" },
      startTime: new Date("2026-03-12T10:00:00.000Z"),
      uid: "uid-1",
    });

    expect(row.recurrenceId).toBe(recurrenceId);
    expect(row.recurrenceRule).toBe('{"frequency":"WEEKLY"}');
    expect(row.exceptionDates).toBe('[{"date":"2026-03-19T10:00:00.000Z"}]');
  });

  it("issues no statements and writes nothing when there are no rows", async () => {
    expect(buildEventStateInsertStatements(database, [])).toEqual([]);
    await expect(insertEventStatesWithConflictResolution(database, [])).resolves.toBeUndefined();
  });

  it("stores a large snapshot in one batch with every statement under D1's parameter cap", async () => {
    // An unbounded ICS feed reports its whole history in one fetch.
    const calendar = await seedCalendar(database);
    const rows = Array.from({ length: 8000 }, (_unused, index) =>
      buildEventStateInsertRow(calendar.id, {
        endTime: new Date(Date.UTC(2026, 2, 12, 11) + index * 60_000),
        startTime: new Date(Date.UTC(2026, 2, 12, 10) + index * 60_000),
        title: `Event ${index}`,
        uid: `uid-${index}`,
      }));

    const statements = buildEventStateInsertStatements(database, rows);
    for (const statement of statements) {
      expect((statement as unknown as { toSQL: () => { params: unknown[] } }).toSQL().params.length)
        .toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }

    await insertEventStatesWithConflictResolution(database, rows);

    expect(await readStates(calendar.id)).toHaveLength(8000);
  });

  it("updates each identity kind in place instead of duplicating it", async () => {
    const calendar = await seedCalendar(database);
    const providerRow: EventStateInsertRow = {
      availability: "busy",
      calendarId: calendar.id,
      endTime: new Date("2026-03-12T11:00:00.000Z"),
      sourceEventId: "provider-event-1",
      sourceEventType: "default",
      sourceEventUid: "uid-1",
      startTime: new Date("2026-03-12T10:00:00.000Z"),
      title: "Focus Block",
    };
    const legacyRow: EventStateInsertRow = {
      calendarId: calendar.id,
      endTime: new Date("2026-03-13T11:00:00.000Z"),
      sourceEventUid: "legacy-uid-1",
      startTime: new Date("2026-03-13T10:00:00.000Z"),
      title: "Legacy",
    };
    const recurringRow: EventStateInsertRow = {
      calendarId: calendar.id,
      endTime: new Date("2026-03-20T11:00:00.000Z"),
      recurrenceId: new Date("2026-03-20T10:00:00.000Z"),
      sourceEventUid: "legacy-recurring-uid-1",
      startTime: new Date("2026-03-20T10:00:00.000Z"),
      title: "Weekly",
    };
    await insertEventStatesWithConflictResolution(database, [providerRow, legacyRow, recurringRow]);

    await insertEventStatesWithConflictResolution(database, [
      // Same provider id, moved and renamed: the provider identity wins.
      { ...providerRow, startTime: new Date("2026-03-12T12:00:00.000Z"), endTime: new Date("2026-03-12T13:00:00.000Z"), title: "Moved" },
      { ...legacyRow, title: "Legacy renamed" },
      { ...recurringRow, title: "Weekly renamed" },
    ]);

    const stored = await readStates(calendar.id);
    const titles = stored.map((row) => row.title).toSorted();
    expect(titles).toEqual(["Legacy renamed", "Moved", "Weekly renamed"]);
  });
});
