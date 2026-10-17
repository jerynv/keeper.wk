import type { Database } from "@keeper.sh/database";

// The upstream API's read-model types, kept so the dashboard receives the same shapes.
type KeeperDatabase = Database;

interface KeeperEventRangeInput {
  from: Date | string;
  to: Date | string;
}

interface KeeperEventFilters {
  calendarId?: string[];
  availability?: string[];
  isAllDay?: boolean;
}

interface KeeperSource {
  id: string;
  name: string;
  calendarType: string;
  capabilities: string[];
  accountId: string;
  provider: string;
  displayName: string | null;
  email: string | null;
  accountIdentifier: string | null;
  needsReauthentication: boolean;
  includeInIcalFeed: boolean;
  unavailableSince: Date | null;
  disabled: boolean;
  providerMissingSince: string | null;
  providerName: string;
  providerIcon: string | null;
  accountLabel: string;
}

interface KeeperEvent {
  id: string;
  /** Persisted event_states id for synced events. */
  eventStateId: string | null;
  startTime: string;
  endTime: string;
  /** Whole-day event: `startTime`/`endTime` are the UTC-midnight day bounds. */
  isAllDay: boolean;
  title: string | null;
  description: string | null;
  location: string | null;
  calendarId: string;
  calendarName: string;
  calendarProvider: string;
  calendarUrl: string | null;
}

export type { KeeperDatabase, KeeperEvent, KeeperEventFilters, KeeperEventRangeInput, KeeperSource };
