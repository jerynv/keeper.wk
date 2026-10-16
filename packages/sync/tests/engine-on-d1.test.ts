import { env } from "cloudflare:workers";
import { generateDeterministicEventUid } from "@keeper.sh/calendar";
import type { CalendarSyncProvider, MaterializedSyncableEvent, RemoteEvent } from "@keeper.sh/calendar";
import { createDatabase } from "@keeper.sh/database";
import {
  SINGLE_USER_ID,
  calendarAccountsTable,
  calendarsTable,
  eventMappingsTable,
  eventStatesTable,
  sourceDestinationMappingsTable,
} from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The real engine against a real D1: syncDestinationsForUser reads event states,
 * mappings, leases and backoff state from the database, plans, and flushes in one batch.
 * Only the destination calendar is faked, as an in-memory store a person could also
 * edit by hand. This is the Phase 4 checklist run below the provider layer.
 */

interface StoredRemote {
  deleteId: string;
  endTime: Date;
  isKeeperEvent: boolean;
  startTime: Date;
  summary: string;
  uid: string;
}

class FakeDestination {
  public readonly events = new Map<string, StoredRemote>();
  public deletes: string[] = [];
  public pushes = 0;
  public failNextFlush = false;
  private nextId = 1;

  public seedHandMade(summary: string, startTime: Date, endTime: Date): string {
    const deleteId = `hand-${this.nextId++}`;
    this.events.set(deleteId, {
      deleteId,
      endTime,
      isKeeperEvent: false,
      startTime,
      summary,
      uid: `${deleteId}@google.com`,
    });
    return deleteId;
  }

  public seedForeignKeeperCopy(startTime: Date, endTime: Date): string {
    const deleteId = `foreign-${this.nextId++}`;
    this.events.set(deleteId, {
      deleteId,
      endTime,
      isKeeperEvent: true,
      startTime,
      summary: "Another Keeper's mirror",
      uid: generateDeterministicEventUid(`other-instance:${deleteId}`),
    });
    return deleteId;
  }

  public readonly provider: CalendarSyncProvider = {
    deleteEvents: (deleteIds) => {
      this.deletes.push(...deleteIds);
      for (const deleteId of deleteIds) {
        this.events.delete(deleteId);
      }
      return Promise.resolve(deleteIds.map(() => ({ success: true })));
    },
    listRemoteEvents: () => Promise.resolve([...this.events.values()].map((event): RemoteEvent => ({
      deleteId: event.deleteId,
      endTime: event.endTime,
      isKeeperEvent: event.isKeeperEvent,
      startTime: event.startTime,
      uid: event.uid,
    }))),
    pushEvents: (events: MaterializedSyncableEvent[]) => Promise.resolve(events.map((event) => {
      this.pushes += 1;
      const uid = generateDeterministicEventUid(`${event.calendarId}:${event.id}`);
      const deleteId = `google-${this.nextId++}`;
      this.events.set(deleteId, {
        deleteId,
        endTime: event.endTime,
        isKeeperEvent: true,
        startTime: event.startTime,
        summary: event.summary,
        uid,
      });
      return { deleteId, remoteId: uid, success: true };
    })),
  };
}

const destination = { current: new FakeDestination() };

vi.mock("../src/resolve-provider", () => ({
  resolveSyncProvider: () => Promise.resolve(destination.current.provider),
}));

const { syncDestinationsForUser } = await import("../src/sync-user");

const database = createDatabase(env.DB);
const DAY_MS = 86_400_000;
const at = (days: number, hours = 9): Date => {
  const date = new Date(Date.now() + days * DAY_MS);
  date.setUTCHours(hours, 0, 0, 0);
  return date;
};

const seedPair = async () => {
  const [account] = await database
    .insert(calendarAccountsTable)
    .values({ authType: "none", provider: "ics" })
    .returning();
  const accountId = account?.id ?? "";
  const now = new Date();
  const [source] = await database.insert(calendarsTable).values({
    accountId,
    calendarType: "ics",
    // The ingest coverage that makes this source authoritative for deletions.
    ingestWindowEnd: new Date(now.getTime() + 1200 * DAY_MS),
    ingestWindowRecordedAt: now,
    ingestWindowStart: new Date(now.getTime() - 60 * DAY_MS),
    name: "IU",
  }).returning();
  const [target] = await database.insert(calendarsTable).values({
    accountId,
    calendarType: "google",
    capabilities: ["pull", "push"],
    name: "Personal",
  }).returning();
  if (!source || !target) {
    throw new Error("seed failed");
  }
  await database.insert(sourceDestinationMappingsTable).values({
    destinationCalendarId: target.id,
    sourceCalendarId: source.id,
  });
  return { source, target };
};

const addSourceEvent = async (calendarId: string, uid: string, title: string, start: Date, end: Date) => {
  const [row] = await database
    .insert(eventStatesTable)
    .values({ calendarId, endTime: end, sourceEventUid: uid, startTime: start, title })
    .returning();
  return row?.id ?? "";
};

const run = (destinationCalendarId: string) => syncDestinationsForUser(SINGLE_USER_ID, {
  database,
  destinationCalendarId,
  oauthConfig: {},
});

const mappingsFor = (calendarId: string) =>
  database.select().from(eventMappingsTable).where(eq(eventMappingsTable.calendarId, calendarId));

describe("the sync engine on D1", () => {
  beforeEach(() => {
    destination.current = new FakeDestination();
  });

  it("pushes a new source event once, records its mapping, and is quiet on the next run", async () => {
    const { source, target } = await seedPair();
    await addSourceEvent(source.id, "lecture-1", "C291 Lecture", at(2), at(2, 10));

    const first = await run(target.id);
    const second = await run(target.id);

    expect(first.added).toBe(1);
    expect(second).toMatchObject({ added: 0, removed: 0 });
    expect(destination.current.events.size).toBe(1);
    const mappings = await mappingsFor(target.id);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.destinationEventUid.endsWith("@keeper.sh")).toBe(true);
  });

  it("follows an edit at the source with exactly one mirror", async () => {
    const { source, target } = await seedPair();
    const stateId = await addSourceEvent(source.id, "lecture-2", "Lab", at(3), at(3, 10));
    await run(target.id);

    await database
      .update(eventStatesTable)
      .set({ endTime: at(3, 11), startTime: at(3, 10) })
      .where(eq(eventStatesTable.id, stateId));
    await run(target.id);
    const settled = await run(target.id);

    const mirrors = [...destination.current.events.values()].filter((event) => event.isKeeperEvent);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]?.startTime).toEqual(at(3, 10));
    expect(settled).toMatchObject({ added: 0, removed: 0 });
  });

  it("removes the mirror when its source event is deleted, using the mapping that outlived it", async () => {
    const { source, target } = await seedPair();
    const stateId = await addSourceEvent(source.id, "lecture-3", "Exam", at(4), at(4, 10));
    await run(target.id);

    await database.delete(eventStatesTable).where(eq(eventStatesTable.id, stateId));
    const result = await run(target.id);

    expect(result.removed).toBe(1);
    expect(destination.current.events.size).toBe(0);
    expect(await mappingsFor(target.id)).toEqual([]);
  });

  it("never touches an event made by hand at the destination, or another instance's keeper copy", async () => {
    const { source, target } = await seedPair();
    await addSourceEvent(source.id, "lecture-4", "Seminar", at(5), at(5, 10));
    const handMade = destination.current.seedHandMade("Dentist", at(5), at(5, 10));
    const foreign = destination.current.seedForeignKeeperCopy(at(6), at(6, 10));

    await run(target.id);
    await run(target.id);
    // Even with every source event gone, neither foreign event is ours to delete.
    await database.delete(eventStatesTable).where(eq(eventStatesTable.calendarId, source.id));
    await run(target.id);

    expect(destination.current.events.has(handMade)).toBe(true);
    expect(destination.current.events.has(foreign)).toBe(true);
    expect(destination.current.deletes).not.toContain(handMade);
    expect(destination.current.deletes).not.toContain(foreign);
  });

  it("serialises two concurrent runs on one destination and still converges to one mirror", async () => {
    const { source, target } = await seedPair();
    await addSourceEvent(source.id, "lecture-5", "Office hours", at(7), at(7, 10));

    await Promise.all([run(target.id), run(target.id)]);
    await run(target.id);

    expect([...destination.current.events.values()].filter((event) => event.isKeeperEvent)).toHaveLength(1);
    expect(await mappingsFor(target.id)).toHaveLength(1);
  });
});
