import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { Database } from "./client";
import { cacheEntriesTable } from "./schema";

const MS_PER_SECOND = 1000;

/*
 * The get/setex/del subset of Redis that upstream's caches were written against, kept in
 * D1. An expired row reads as missing; writes clear expired rows as they go.
 */
const createCacheStore = (database: Database) => ({
  del: async (...keys: string[]): Promise<number> => {
    if (keys.length === 0) {
      return 0;
    }
    const removed = await database
      .delete(cacheEntriesTable)
      .where(inArray(cacheEntriesTable.key, keys))
      .returning({ key: cacheEntriesTable.key });
    return removed.length;
  },
  get: async (key: string): Promise<string | null> => {
    const [entry] = await database
      .select({ value: cacheEntriesTable.value })
      .from(cacheEntriesTable)
      .where(and(eq(cacheEntriesTable.key, key), gt(cacheEntriesTable.expiresAt, Date.now())))
      .limit(1);
    return entry?.value ?? null;
  },
  setex: async (key: string, seconds: number, value: string): Promise<void> => {
    const expiresAt = Date.now() + seconds * MS_PER_SECOND;
    await database.delete(cacheEntriesTable).where(lte(cacheEntriesTable.expiresAt, Date.now()));
    await database
      .insert(cacheEntriesTable)
      .values({ expiresAt, key, value })
      .onConflictDoUpdate({ set: { expiresAt, value }, target: cacheEntriesTable.key });
  },
});

export { createCacheStore };
