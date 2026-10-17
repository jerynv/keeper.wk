import type { SyncMessage } from "./messages";

interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncMessage>;
  ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare Access: the team domain (https://<team>.cloudflareaccess.com) and app AUD tag.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Public origin of the settings page, e.g. https://cal.jeryn.me (OAuth redirect base).
  PUBLIC_ORIGIN?: string;
}

export type { Env };
