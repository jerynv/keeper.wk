import type { SyncMessage } from "./messages";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncMessage>;
  ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare Access: the team domain (https://<team>.cloudflareaccess.com) and app AUD tag.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // The only Access identity let in, checked on top of the Access policy.
  OWNER_EMAIL?: string;
  // Public origin of the settings page, e.g. https://cal.jeryn.me (OAuth redirect base).
  PUBLIC_ORIGIN?: string;
  // Where this fork's source is published, linked from every page (AGPL-3.0 section 13).
  SOURCE_URL?: string;
  // The timezone the settings page shows days and times in.
  TIMEZONE?: string;
}

export type { Env };
