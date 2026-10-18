import { describe, expect, it, vi } from "vitest";

const dav = vi.hoisted(() => ({ calendarQuery: vi.fn(), fetchCalendars: vi.fn() }));

vi.mock("tsdav", () => ({
  DAVNamespaceShort: { DAV: "d" },
  createDAVClient: () => Promise.resolve(dav),
}));

const { createCalDAVSyncProvider } = await import("../../../../src/providers/caldav/destination/provider");

const CALENDAR_URL = "https://dav.example/home/work/";

const makeProvider = (cache?: {
  read: () => Promise<{ displayName: string; url: string }[] | null>;
  write: (calendars: { displayName: string; url: string }[]) => Promise<void>;
}) => createCalDAVSyncProvider({
  calendarDiscoveryCache: cache,
  calendarUrl: CALENDAR_URL,
  password: "secret",
  serverUrl: "https://dav.example/",
  username: "jeryn",
});

const WINDOW = { timeMax: new Date("2027-01-01"), timeMin: new Date("2026-01-01") };

describe("pushing to a CalDAV calendar", () => {
  it("lists the calendar without walking the account when the walk is cached", async () => {
    dav.fetchCalendars.mockClear();
    dav.calendarQuery.mockClear().mockResolvedValue([]);
    const cached = [{ displayName: "Work", url: CALENDAR_URL }];

    await makeProvider({ read: () => Promise.resolve(cached), write: () => Promise.resolve() })
      .listRemoteEvents(WINDOW);

    expect(dav.fetchCalendars).not.toHaveBeenCalled();
    expect(dav.calendarQuery).toHaveBeenCalledTimes(1);
  });

  it("walks once and records it when nothing is cached yet", async () => {
    dav.fetchCalendars.mockClear().mockResolvedValue([{ components: ["VEVENT"], displayName: "Work", url: CALENDAR_URL }]);
    dav.calendarQuery.mockClear().mockResolvedValue([]);
    const write = vi.fn(() => Promise.resolve());

    await makeProvider({ read: () => Promise.resolve(null), write }).listRemoteEvents(WINDOW);

    expect(dav.fetchCalendars).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith([{ ctag: undefined, displayName: "Work", url: CALENDAR_URL }]);
  });
});
