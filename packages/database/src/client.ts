import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";

type Database = DrizzleD1Database;

const createDatabase = (binding: Parameters<typeof drizzle>[0]): Database => drizzle(binding);

/*
 * D1 caps a statement at 100 bound parameters. Any bulk insert or
 * `IN (...)` list is split into chunks that stay under it.
 */
const D1_MAX_BOUND_PARAMETERS = 100;

const chunk = <TItem>(items: TItem[], size: number): TItem[][] => {
  const chunks: TItem[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

/*
 * The reservedParameters argument covers what the rest of the statement binds (a SET clause, an
 * updatedAt stamp, another WHERE term), so the list itself gets only what is left.
 */
const chunkForParameters = <TItem>(
  items: TItem[],
  parametersPerItem = 1,
  reservedParameters = 0,
): TItem[][] =>
  chunk(
    items,
    Math.max(1, Math.floor((D1_MAX_BOUND_PARAMETERS - reservedParameters) / parametersPerItem)),
  );

// A multi-row insert can bind every column of every row, so size chunks by the table.
const chunkRowsForInsert = <TRow>(table: Table, rows: TRow[]): TRow[][] =>
  chunkForParameters(rows, Object.keys(getTableColumns(table)).length);

type DatabaseBatchItem = BatchItem<"sqlite">;

/*
 * D1 rejects BEGIN, so a group of writes that must land together goes through
 * batch(), which D1 runs atomically. An empty group is a no-op.
 */
const runBatch = (database: Database, statements: DatabaseBatchItem[]): Promise<unknown[]> => {
  const [first, ...rest] = statements;
  if (!first) {
    return Promise.resolve([]);
  }
  return database.batch([first, ...rest]);
};

export {
  D1_MAX_BOUND_PARAMETERS,
  chunkForParameters,
  chunkRowsForInsert,
  createDatabase,
  runBatch,
};
export type { Database, DatabaseBatchItem };
