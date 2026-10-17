import type { OAuthStateStore } from "@keeper.sh/calendar";
import type { Database } from "@keeper.sh/database";
import { oauthStatesTable } from "@keeper.sh/database/schema";
import { and, eq, gt, lte } from "drizzle-orm";

const MS_PER_SECOND = 1000;

/*
 * Google OAuth state in D1. consume() is one DELETE ... RETURNING, so a state can be
 * spent once: a second callback with the same state, replayed or raced, finds nothing.
 */
const createOAuthStateStore = (database: Database): OAuthStateStore => ({
  consume: async (key) => {
    const rows = await database
      .delete(oauthStatesTable)
      .where(and(eq(oauthStatesTable.key, key), gt(oauthStatesTable.expiresAt, Date.now())))
      .returning({ value: oauthStatesTable.value });
    return rows[0]?.value ?? null;
  },
  set: async (key, value, ttlSeconds) => {
    // Abandoned handshakes are cleared here rather than by a job of their own.
    await database.delete(oauthStatesTable).where(lte(oauthStatesTable.expiresAt, Date.now()));
    await database.insert(oauthStatesTable).values({
      expiresAt: Date.now() + ttlSeconds * MS_PER_SECOND,
      key,
      value,
    });
  },
});

export { createOAuthStateStore };
