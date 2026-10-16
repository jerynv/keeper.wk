import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/*
 * Upstream stores capabilities as a Postgres text[] and filters with arrayContains.
 * Here the column is a JSON array, so membership is a json_each lookup.
 */
const hasCapability = (column: SQLiteColumn, capability: string): SQL =>
  sql`exists (select 1 from json_each(${column}) where json_each.value = ${capability})`;

export { hasCapability };
