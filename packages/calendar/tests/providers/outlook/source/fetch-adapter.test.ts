import { afterEach, describe, expect, it } from "vitest";
import { getOAuthSyncTokenVersion } from "../../../../src/core/oauth/sync-window";
import {
  encodeStoredSyncToken,
  resolveSyncTokenForWindow,
} from "../../../../src/core/oauth/sync-token";
import { createOutlookSourceFetcher } from "../../../../src/providers/outlook/source/fetch-adapter";
import { createSourceIngestionPlan } from "../../../../src/core/sync/sync-range";

const CALENDAR_ID = "calendar-id";
const OUTLOOK_SYNC_TOKEN_VERSION = getOAuthSyncTokenVersion(1, new Date(), CALENDAR_ID);
const TENTATIVE_AWARE_SYNC_TOKEN_VERSION = getOAuthSyncTokenVersion(2, new Date(), CALENDAR_ID);
const CURRENT_DELTA_LINK = "https://graph.microsoft.com/delta?$deltatoken=current";
const NEXT_DELTA_LINK = "https://graph.microsoft.com/delta?$deltatoken=next";
const TEST_PLAN = createSourceIngestionPlan("1_week", "2_years");
const originalFetch = globalThis.fetch;
const fetchKeeperCategoryDelta = (): Promise<Response> => Promise.resolve(Response.json({
  "@odata.deltaLink": "https://graph.microsoft.com/delta?$deltatoken=next",
  value: [{
    categories: ["keeper.sh"],
    end: { dateTime: "2027-03-08T15:00:00.000Z", timeZone: "UTC" },
    iCalUId: "external-uid-1",
    id: "outlook-event-id-1",
    start: { dateTime: "2027-03-08T14:00:00.000Z", timeZone: "UTC" },
  }],
}));
const fetchSeriesMasterDelta = (): Promise<Response> => Promise.resolve(Response.json({
  "@odata.deltaLink": "https://graph.microsoft.com/delta?$deltatoken=next",
  value: [{ id: "series-master-1", type: "seriesMaster" }],
}));
const fetchOutlookDeltaWithoutSuccessor = (): Promise<Response> => Promise.resolve(Response.json({
  value: [{
    end: { dateTime: "2026-03-08T15:00:00.000Z", timeZone: "UTC" },
    iCalUId: "external-uid-1",
    id: "outlook-event-id-1",
    start: { dateTime: "2026-03-08T14:00:00.000Z", timeZone: "UTC" },
  }],
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createOutlookSourceFetcher", () => {
  it("returns a versioned delta link that the next cron run accepts", async () => {
    const rawDeltaLink = "https://graph.microsoft.com/delta?$deltatoken=next";
    const queuedFetch = (): Promise<Response> => Promise.resolve(Response.json({
      "@odata.deltaLink": rawDeltaLink,
      value: [],
    }));
    globalThis.fetch = queuedFetch;
    const fetcher = createOutlookSourceFetcher({
      accessToken: "test-token",
      calendarId: CALENDAR_ID,
      plan: TEST_PLAN,
      externalCalendarId: "calendar-id",
      syncToken: null,
    });

    const result = await fetcher.fetchEvents();

    expect(result.nextSyncToken).not.toBe(rawDeltaLink);
    expect(resolveSyncTokenForWindow(
      result.nextSyncToken ?? null,
      OUTLOOK_SYNC_TOKEN_VERSION,
    )).toEqual({
      requiresBackfill: false,
      syncToken: rawDeltaLink,
    });
  });

  it("reports changed provider IDs without storing delta events outside the sync window", async () => {
    const nextDeltaLink = "https://graph.microsoft.com/delta?$deltatoken=next";
    const queuedFetch = (): Promise<Response> => Promise.resolve(Response.json({
      "@odata.deltaLink": nextDeltaLink,
      value: [{
        end: { dateTime: "2098-03-08T15:00:00.000Z", timeZone: "UTC" },
        iCalUId: "external-uid-1",
        id: "outlook-event-id-1",
        start: { dateTime: "2098-03-08T14:00:00.000Z", timeZone: "UTC" },
      }],
    }));
    globalThis.fetch = queuedFetch;
    const fetcher = createOutlookSourceFetcher({
      accessToken: "test-token",
      calendarId: CALENDAR_ID,
      plan: TEST_PLAN,
      externalCalendarId: "calendar-id",
      syncToken: encodeStoredSyncToken(
        "https://graph.microsoft.com/delta?$deltatoken=current",
        OUTLOOK_SYNC_TOKEN_VERSION,
      ),
    });

    const result = await fetcher.fetchEvents();

    expect(result.events).toEqual([]);
    expect(result.changedEventIds).toEqual(["outlook-event-id-1"]);
  });

  it("reports raw changed IDs for delta events excluded during parsing", async () => {
    globalThis.fetch = fetchKeeperCategoryDelta;
    const fetcher = createOutlookSourceFetcher({
      accessToken: "test-token",
      calendarId: CALENDAR_ID,
      plan: TEST_PLAN,
      externalCalendarId: "calendar-id",
      syncToken: encodeStoredSyncToken(
        "https://graph.microsoft.com/delta?$deltatoken=current",
        OUTLOOK_SYNC_TOKEN_VERSION,
      ),
    });

    const result = await fetcher.fetchEvents();

    expect(result.events).toEqual([]);
    expect(result.changedEventIds).toEqual(["outlook-event-id-1"]);
  });

  it("requests a full backfill when Graph returns a series master during delta sync", async () => {
    globalThis.fetch = fetchSeriesMasterDelta;
    const fetcher = createOutlookSourceFetcher({
      accessToken: "test-token",
      calendarId: CALENDAR_ID,
      plan: TEST_PLAN,
      externalCalendarId: "calendar-id",
      syncToken: encodeStoredSyncToken(
        "https://graph.microsoft.com/delta?$deltatoken=current",
        OUTLOOK_SYNC_TOKEN_VERSION,
      ),
    });

    await expect(fetcher.fetchEvents()).resolves.toEqual({
      events: [],
      fullSyncRequired: true,
      syncWindow: TEST_PLAN.window,
    });
  });

  it("requests a full sync instead of replaying a delta with no successor link", async () => {
    globalThis.fetch = fetchOutlookDeltaWithoutSuccessor;

    const result = await createOutlookSourceFetcher({
      accessToken: "test-token",
      calendarId: CALENDAR_ID,
      plan: TEST_PLAN,
      externalCalendarId: "calendar-id",
      syncToken: encodeStoredSyncToken(
        "https://graph.microsoft.com/delta?$deltatoken=current",
        OUTLOOK_SYNC_TOKEN_VERSION,
      ),
    }).fetchEvents();

    expect(result).toEqual({
      events: [],
      fullSyncRequired: true,
      syncWindow: TEST_PLAN.window,
    });
  });

  describe("tentative reclassification", () => {
    const recordRequestedUrls = (): string[] => {
      const requestedUrls: string[] = [];
      const recordingFetch = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        requestedUrls.push(String(input));
        return Promise.resolve(Response.json({
          "@odata.deltaLink": NEXT_DELTA_LINK,
          value: [],
        }));
      };
      globalThis.fetch = recordingFetch;
      return requestedUrls;
    };

    const fetchWith = (syncToken: string | null, excludesTentative: boolean) =>
      createOutlookSourceFetcher({
        accessToken: "test-token",
        calendarId: CALENDAR_ID,
        excludesTentative,
        externalCalendarId: "calendar-id",
        plan: TEST_PLAN,
        syncToken,
      }).fetchEvents();

    it("refetches the window once when a calendar excludes tentative on a pre-tentative token", async () => {
      const requestedUrls = recordRequestedUrls();

      const result = await fetchWith(
        encodeStoredSyncToken(CURRENT_DELTA_LINK, OUTLOOK_SYNC_TOKEN_VERSION),
        true,
      );

      expect(requestedUrls).not.toContain(CURRENT_DELTA_LINK);
      expect(result.isDeltaSync).toBe(false);
      expect(resolveSyncTokenForWindow(
        result.nextSyncToken ?? null,
        TENTATIVE_AWARE_SYNC_TOKEN_VERSION,
      ).syncToken).toBe(NEXT_DELTA_LINK);
    });

    it("keeps delta syncing on a tentative-aware token however often tentative is toggled", async () => {
      const requestedUrls = recordRequestedUrls();
      const awareToken = encodeStoredSyncToken(CURRENT_DELTA_LINK, TENTATIVE_AWARE_SYNC_TOKEN_VERSION);

      await fetchWith(awareToken, true);
      await fetchWith(awareToken, false);
      await fetchWith(awareToken, true);

      expect(requestedUrls).toEqual([CURRENT_DELTA_LINK, CURRENT_DELTA_LINK, CURRENT_DELTA_LINK]);
    });

    it("keeps delta syncing on a pre-tentative token when tentative is not excluded", async () => {
      const requestedUrls = recordRequestedUrls();

      await fetchWith(encodeStoredSyncToken(CURRENT_DELTA_LINK, OUTLOOK_SYNC_TOKEN_VERSION), false);

      expect(requestedUrls).toEqual([CURRENT_DELTA_LINK]);
    });

    it("does not let a delta sync promote a pre-tentative token", async () => {
      recordRequestedUrls();

      const result = await fetchWith(
        encodeStoredSyncToken(CURRENT_DELTA_LINK, OUTLOOK_SYNC_TOKEN_VERSION),
        false,
      );

      expect(resolveSyncTokenForWindow(
        result.nextSyncToken ?? null,
        TENTATIVE_AWARE_SYNC_TOKEN_VERSION,
      ).syncToken).toBeNull();
    });
  });
});
