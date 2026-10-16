import type { Database } from "@keeper.sh/database";
import { calendarSnapshotsTable, calendarsTable } from "@keeper.sh/database/schema";
import { eq } from "drizzle-orm";
import type { CalendarSnapshotChange } from "../../core/sync-engine/ingest";

const computeContentHash = async (content: string): Promise<string> => {
  const encoded = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);

  const hexParts: string[] = [];
  for (const byte of hashArray) {
    hexParts.push(byte.toString(16).padStart(2, "0"));
  }

  return hexParts.join("");
};

interface PrepareSnapshotResult {
  changed: boolean;
  snapshot?: CalendarSnapshotChange;
}

const prepareCalendarSnapshotChange = async (
  ical: string,
  calendarExists: boolean,
  existingContentHash?: string | null,
): Promise<PrepareSnapshotResult> => {
  if (!calendarExists) {
    return { changed: false };
  }
  const contentHash = await computeContentHash(ical);
  if (existingContentHash === contentHash) {
    return { changed: false };
  }
  return {
    changed: true,
    snapshot: { ical, contentHash },
  };
};

const prepareCalendarSnapshot = async (
  database: Database,
  calendarId: string,
  ical: string,
): Promise<PrepareSnapshotResult> => {
  const [calendar] = await database
    .select({ id: calendarsTable.id })
    .from(calendarsTable)
    .where(eq(calendarsTable.id, calendarId));

  if (!calendar) {
    return prepareCalendarSnapshotChange(ical, false);
  }

  const [existing] = await database
    .select({ contentHash: calendarSnapshotsTable.contentHash })
    .from(calendarSnapshotsTable)
    .where(eq(calendarSnapshotsTable.calendarId, calendarId));

  return prepareCalendarSnapshotChange(ical, true, existing?.contentHash);
};

// Only the hash is stored: the engine never reads the feed text back.
const buildPersistCalendarSnapshot = (
  database: Pick<Database, "insert">,
  calendarId: string,
  snapshot: CalendarSnapshotChange,
) => database
  .insert(calendarSnapshotsTable)
  .values({
    calendarId,
    contentHash: snapshot.contentHash,
  })
  .onConflictDoUpdate({
    target: calendarSnapshotsTable.calendarId,
    set: {
      contentHash: snapshot.contentHash,
      createdAt: new Date(),
    },
  });

const persistCalendarSnapshot = async (
  database: Pick<Database, "insert">,
  calendarId: string,
  snapshot: CalendarSnapshotChange,
): Promise<void> => {
  await buildPersistCalendarSnapshot(database, calendarId, snapshot);
};

export {
  buildPersistCalendarSnapshot,
  persistCalendarSnapshot,
  prepareCalendarSnapshot,
  prepareCalendarSnapshotChange,
};
