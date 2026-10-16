import { describe, expect, it } from "vitest";
import { computeSyncOperations } from "../../../src/core/sync/operations";
import type { ReconciliationScope } from "../../../src/core/sync/operations";
import { createSyncEventContentHash } from "../../../src/core/events/content-hash";
import type { EventMapping } from "../../../src/core/events/mappings";
import type { MaterializedSyncableEvent, RemoteEvent } from "../../../src/core/types";

/*
 * Keeper must never delete or modify a destination event it did not create. Every
 * delete (remove, or the delete half of a replace) must be backed by the keeper marker
 * on the uid AND a mapping row recording that uid.
 */

const WINDOW = {
  timeMax: new Date("2026-04-01T00:00:00.000Z"),
  timeMin: new Date("2026-03-01T00:00:00.000Z"),
};

const SCOPE: ReconciliationScope = {
  authoritativeWindow: WINDOW,
  requestedWindow: WINDOW,
};

const START = new Date("2026-03-08T14:00:00.000Z");
const END = new Date("2026-03-08T15:00:00.000Z");

const localEvent = (overrides: Partial<MaterializedSyncableEvent> = {}): MaterializedSyncableEvent => ({
  calendarId: "source-calendar-id",
  calendarName: "Source",
  calendarUrl: null,
  endTime: END,
  id: "event-state-1",
  sourceEventUid: "source-uid-1",
  startTime: START,
  summary: "Meeting",
  ...overrides,
});

const mapping = (overrides: Partial<EventMapping> = {}): EventMapping => ({
  calendarId: "destination-calendar-id",
  deleteIdentifier: "google-event-id-1",
  destinationEventUid: "abc123@keeper.sh",
  endTime: END,
  eventStateId: "event-state-1",
  id: "mapping-1",
  sourceCalendarId: "source-calendar-id",
  startTime: START,
  syncEventHash: "hash",
  syncEventId: "event-state-1",
  ...overrides,
});

const remote = (overrides: Partial<RemoteEvent> = {}): RemoteEvent => ({
  deleteId: "google-event-id-1",
  endTime: END,
  isKeeperEvent: true,
  startTime: START,
  uid: "abc123@keeper.sh",
  ...overrides,
});

const deletions = (operations: ReturnType<typeof computeSyncOperations>["operations"]) =>
  operations.filter((operation) => operation.type !== "add");

describe("keeper ownership invariant", () => {
  it("never deletes a hand-made destination event, mapped or not", () => {
    const handMade = remote({ deleteId: "user-event", isKeeperEvent: false, uid: "user@google.com" });

    const result = computeSyncOperations([], [], [handMade], SCOPE);

    expect(result.operations).toEqual([]);
  });

  it("never deletes through a mapping whose uid lacks the keeper marker", () => {
    // A corrupt row pointing at a hand-made event whose source has gone.
    const corrupt = mapping({ deleteIdentifier: "user-event", destinationEventUid: "user@google.com" });
    const handMade = remote({ deleteId: "user-event", isKeeperEvent: false, uid: "user@google.com" });

    const result = computeSyncOperations([], [corrupt], [handMade], SCOPE);

    expect(deletions(result.operations)).toEqual([]);
    expect(result.staleMappingIds).toEqual([]);
  });

  it("never replaces (deletes then re-adds) through an unmarked mapping", () => {
    const event = localEvent();
    // Local hash changed, so upstream would delete the old copy and push a new one.
    const corrupt = mapping({ deleteIdentifier: "user-event", destinationEventUid: "user@google.com" });
    const handMade = remote({ deleteId: "user-event", isKeeperEvent: false, uid: "user@google.com" });

    const result = computeSyncOperations([event], [corrupt], [handMade], SCOPE);

    expect(result.operations).toEqual([]);
    expect(result.staleMappingIds).toEqual([]);
  });

  it("never deletes a keeper-tagged event that no mapping row records", () => {
    // For example, a copy pushed by another Keeper instance into the same calendar.
    const foreignKeeperCopy = remote({ deleteId: "other-id", uid: "other-instance@keeper.sh" });

    const result = computeSyncOperations([], [], [foreignKeeperCopy], SCOPE);

    expect(result.operations).toEqual([]);
  });

  it("still deletes Keeper's own mirror once its source event is gone", () => {
    const own = mapping();

    const result = computeSyncOperations([], [own], [remote()], SCOPE);

    expect(result.operations).toEqual([{
      deleteId: "google-event-id-1",
      mappingId: "mapping-1",
      startTime: START,
      type: "remove",
      uid: "abc123@keeper.sh",
    }]);
  });

  it("still removes a duplicate copy of a mapped keeper uid, keeping the canonical one", () => {
    const event = localEvent();
    const own = mapping({ syncEventHash: createSyncEventContentHash(event) });
    const duplicate = remote({ deleteId: "duplicate-id" });

    const result = computeSyncOperations([event], [own], [remote(), duplicate], SCOPE);

    expect(result.operations).toEqual([{
      deleteId: "duplicate-id",
      startTime: START,
      type: "remove",
      uid: "abc123@keeper.sh",
    }]);
  });
});
