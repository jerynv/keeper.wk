import { createRefreshLockStore } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";
import { SINGLE_USER_ID, syncStatusTable } from "@keeper.sh/database/schema";
import { syncDestinationsForUser } from "@keeper.sh/sync";
import { widelog } from "./telemetry";

interface PushConfig {
  database: Database;
  encryptionKey: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

// Upstream's worker gave a destination run 10 minutes; a queue consumer has 15 of wall time.
const PUSH_DEADLINE_MS = 10 * 60 * 1000;

const ERROR_SUMMARY_LIMIT = 500;

/*
 * Reconciles one destination calendar against its mapped sources. The engine takes the
 * destination's own lease and the source leases itself; this records the outcome so the
 * settings page can show when a calendar last synced and why it last failed.
 */
const pushDestinationCalendar = async (config: PushConfig, calendarId: string): Promise<void> => {
  let skipped = false;
  const result = await syncDestinationsForUser(SINGLE_USER_ID, {
    database: config.database,
    deadlineMs: Date.now() + PUSH_DEADLINE_MS,
    destinationCalendarId: calendarId,
    encryptionKey: config.encryptionKey,
    oauthConfig: {
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
    },
    refreshLockStore: createRefreshLockStore(config.database),
  }, {
    onCalendarSkipped: (skip) => {
      widelog.set("sync.skip_reason", skip.reason);
      skipped = true;
    },
  });

  widelog.set("sync.events_added", result.added);
  widelog.set("sync.events_removed", result.removed);
  widelog.set("sync.add_failed", result.addFailed);
  widelog.set("sync.remove_failed", result.removeFailed);

  // A skipped run, such as one held back after failures, says nothing new about the calendar.
  if (skipped) {
    return;
  }

  const lastError = result.errors.join("; ").slice(0, ERROR_SUMMARY_LIMIT) || null;
  const now = new Date();
  await config.database
    .insert(syncStatusTable)
    .values({ calendarId, lastError, lastSyncedAt: now })
    .onConflictDoUpdate({
      set: { lastError, lastSyncedAt: now },
      target: syncStatusTable.calendarId,
    });
};

export { pushDestinationCalendar };
export type { PushConfig };
