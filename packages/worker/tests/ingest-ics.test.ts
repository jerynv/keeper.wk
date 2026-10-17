import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { createDatabase, tryAcquireLease } from "@keeper.sh/database";
import {
  calendarAccountsTable,
  calendarSnapshotsTable,
  calendarsTable,
  eventStatesTable,
  sourceDestinationMappingsTable,
} from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { INGEST_RUN_LEASE_PREFIX, ingestSourceCalendar } from "../src/ingest/run-source";
import type { SyncMessage } from "../src/messages";
import { planScheduledMessages } from "../src/schedule";

const database = createDatabase(env.DB);
const config = { database, encryptionKey: env.ENCRYPTION_KEY };
const FEED_URL = "https://feeds.example.edu/iu.ics";

const icsDate = (date: Date): string => date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}/, "");

const dayFromNow = (days: number, hour: number): Date => {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
};

interface FeedEvent {
  summary: string;
  uid: string;
  start: Date;
  end: Date;
}

const feed = (events: FeedEvent[]): string => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//IU//EN",
  ...events.flatMap((event) => [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end)}`,
    `SUMMARY:${event.summary}`,
    "END:VEVENT",
  ]),
  "END:VCALENDAR",
  "",
].join("\r\n");

const LECTURE: FeedEvent = { end: dayFromNow(2, 11), start: dayFromNow(2, 10), summary: "C291 Lecture", uid: "lecture@iu.edu" };
const LAB: FeedEvent = { end: dayFromNow(3, 15), start: dayFromNow(3, 14), summary: "C291 Lab", uid: "lab@iu.edu" };

const serveFeed = (body: () => string | Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    let url = String(input);
    if (input instanceof Request) {
      ({ url } = input);
    }
    if (url !== FEED_URL) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }
    const result = body();
    if (result instanceof Response) {
      return Promise.resolve(result);
    }
    return Promise.resolve(new Response(result, { headers: { "content-type": "text/calendar" } }));
  });

const seedIcsSource = async () => {
  const [account] = await database
    .insert(calendarAccountsTable)
    .values({ authType: "none", provider: "ics" })
    .returning();
  const [source] = await database.insert(calendarsTable).values({
    accountId: account?.id ?? "",
    calendarType: "ical",
    name: "IU",
    url: FEED_URL,
  }).returning();
  const [destination] = await database.insert(calendarsTable).values({
    accountId: account?.id ?? "",
    calendarType: "caldav",
    capabilities: ["pull", "push"],
    name: "iCloud",
  }).returning();
  if (!source || !destination) {
    throw new Error("seed failed");
  }
  await database.insert(sourceDestinationMappingsTable).values({
    destinationCalendarId: destination.id,
    sourceCalendarId: source.id,
  });
  return { destination, source };
};

const statesOf = async (calendarId: string) => {
  const rows = await database.select().from(eventStatesTable).where(eq(eventStatesTable.calendarId, calendarId));
  return rows.map((row) => row.sourceEventUid).toSorted();
};

const calendarRow = async (calendarId: string) => {
  const [row] = await database.select().from(calendarsTable).where(eq(calendarsTable.id, calendarId));
  return row;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ICS source ingest in the Worker", () => {
  it("stores the feed's events, records coverage and the snapshot hash, and asks for a push", async () => {
    const { source } = await seedIcsSource();
    serveFeed(() => feed([LECTURE, LAB]));

    const outcome = await ingestSourceCalendar(config, source.id);

    expect(outcome).toEqual({ shouldPush: true, status: "ingested" });
    expect(await statesOf(source.id)).toEqual(["lab@iu.edu", "lecture@iu.edu"]);
    const row = await calendarRow(source.id);
    expect(row?.ingestWindowRecordedAt).toBeInstanceOf(Date);
    expect(row?.ingestSeq).toBe(1);
    const [snapshot] = await database.select().from(calendarSnapshotsTable)
      .where(eq(calendarSnapshotsTable.calendarId, source.id));
    expect(snapshot?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does nothing on a rerun of an unchanged feed", async () => {
    const { source } = await seedIcsSource();
    serveFeed(() => feed([LECTURE, LAB]));
    await ingestSourceCalendar(config, source.id);

    const second = await ingestSourceCalendar(config, source.id);

    expect(second).toEqual({ shouldPush: false, status: "ingested" });
    expect(await statesOf(source.id)).toEqual(["lab@iu.edu", "lecture@iu.edu"]);
  });

  it("drops an event the feed stopped reporting", async () => {
    const { source } = await seedIcsSource();
    let events = [LECTURE, LAB];
    serveFeed(() => feed(events));
    await ingestSourceCalendar(config, source.id);

    events = [LECTURE];
    const outcome = await ingestSourceCalendar(config, source.id);

    expect(outcome.shouldPush).toBe(true);
    expect(await statesOf(source.id)).toEqual(["lecture@iu.edu"]);
  });

  it("keeps every stored event and backs off when the provider fails", async () => {
    const { source } = await seedIcsSource();
    let fail = false;
    serveFeed(() => {
      if (fail) {
        return new Response("upstream down", { status: 503 });
      }
      return feed([LECTURE, LAB]);
    });
    await ingestSourceCalendar(config, source.id);

    fail = true;
    const outcome = await ingestSourceCalendar(config, source.id);

    expect(outcome.status).toBe("failed");
    expect(await statesOf(source.id)).toEqual(["lab@iu.edu", "lecture@iu.edu"]);
    const row = await calendarRow(source.id);
    expect(row?.ingestFailureCount).toBe(1);
    expect(row?.ingestNextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    // Inside the backoff window the next tick does not even fetch.
    fail = false;
    const during = await ingestSourceCalendar(config, source.id);
    expect(during.status).toBe("skipped");
  });

  it("skips a source another run is already ingesting", async () => {
    const { source } = await seedIcsSource();
    const fetchSpy = serveFeed(() => feed([LECTURE]));
    expect(await tryAcquireLease(database, `${INGEST_RUN_LEASE_PREFIX}${source.id}`, "other-run", 60_000)).toBe(true);

    const outcome = await ingestSourceCalendar(config, source.id);

    expect(outcome.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a feed URL that points at a private address", async () => {
    const { source } = await seedIcsSource();
    await database.update(calendarsTable).set({ url: "http://169.254.169.254/latest/meta-data" })
      .where(eq(calendarsTable.id, source.id));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = await ingestSourceCalendar(config, source.id);

    expect(outcome.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("cron and queue wiring", () => {
  it("plans an ingest for every mapped source and a push for every mapped destination", async () => {
    const { destination, source } = await seedIcsSource();

    const messages = await planScheduledMessages(database);

    expect(messages).toContainEqual({ calendarId: source.id, kind: "ingest" });
    expect(messages).toContainEqual({ calendarId: destination.id, kind: "push" });
    expect(messages).not.toContainEqual({ calendarId: destination.id, kind: "ingest" });
  });

  it("acks an ingest message and queues a push for the source's destinations when it changed", async () => {
    const { destination, source } = await seedIcsSource();
    serveFeed(() => feed([LECTURE]));
    const sent: SyncMessage[] = [];
    const queue = {
      sendBatch: (batch: { body: SyncMessage }[]) => {
        sent.push(...batch.map(({ body }) => body));
        return Promise.resolve();
      },
    } as unknown as Queue<SyncMessage>;
    const batch = createMessageBatch<SyncMessage>("keeper-sync", [
      { attempts: 1, body: { calendarId: source.id, kind: "ingest" }, id: "m1", timestamp: new Date() },
    ]);
    const context = createExecutionContext();

    await worker.queue?.(batch, { ...env, SYNC_QUEUE: queue }, context);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["m1"]);
    expect(result.retryMessages).toEqual([]);
    expect(sent).toEqual([{ calendarId: destination.id, kind: "push" }]);
  });
});
