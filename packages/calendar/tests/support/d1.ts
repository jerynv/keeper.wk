import { env } from "cloudflare:workers";
import { createDatabase } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";
import { calendarAccountsTable, calendarsTable } from "@keeper.sh/database/schema";

// The migrated local D1 the test runner binds as DB (see vitest.config.ts).
const testDatabase = (): Database => createDatabase(env.DB);

interface SeedCalendarOptions {
  accountId?: string;
  calendarType?: string;
  capabilities?: string[];
  id?: string;
  name?: string;
  provider?: string;
}

const seedCalendar = async (database: Database, options: SeedCalendarOptions = {}) => {
  const accountId = options.accountId ?? crypto.randomUUID();
  await database
    .insert(calendarAccountsTable)
    .values({ authType: "none", id: accountId, provider: options.provider ?? "ics" })
    .onConflictDoNothing();
  const [calendar] = await database
    .insert(calendarsTable)
    .values({
      accountId,
      calendarType: options.calendarType ?? "ics",
      capabilities: options.capabilities ?? ["pull"],
      id: options.id ?? crypto.randomUUID(),
      name: options.name ?? "Test calendar",
    })
    .returning();
  if (!calendar) {
    throw new Error("seedCalendar inserted nothing");
  }
  return calendar;
};

export { seedCalendar, testDatabase };
