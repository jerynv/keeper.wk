import { DrizzleQueryError } from "drizzle-orm/errors";

/*
 * D1 reports failures as plain Errors whose message starts with "D1_" (for example
 * "D1_ERROR: UNIQUE constraint failed: event_mappings.calendarId, ..."), and drizzle
 * wraps them in a DrizzleQueryError carrying the SQL and its bound parameters. There
 * are no SQLSTATE codes, so classification works from those messages.
 */

interface DatabaseErrorClassification {
  slug: string;
  sqlState: string | null;
}

interface DatabaseErrorDetails {
  constraint: string | null;
  detail: string | null;
  message: string | null;
  sqlState: string | null;
}

const D1_MESSAGE_PREFIX = "D1_";
const UNCLASSIFIED_DATABASE_SLUG = "db-query-failed";
const MAX_CHAIN_LINKS = 32;
const CONSTRAINT_PATTERN = /(UNIQUE|CHECK|FOREIGN KEY|NOT NULL) constraint failed(?::\s*(.+))?/;

/*
 * Cloudflare documents these as retryable: the request never reached, or was cut off
 * from, the database's storage. A constraint or SQL error is never transient.
 */
const TRANSIENT_D1_PATTERNS: [RegExp, string][] = [
  [/Network connection lost/i, "db-connection-lost"],
  [/storage caused object to be reset|reset because its code was updated|object to be reset/i, "db-storage-reset"],
  [/overloaded/i, "db-overloaded"],
  [/timed? ?out|exceeded timeout/i, "db-timeout"],
  [/Internal error/i, "db-internal-error"],
];

const readMessage = (value: unknown): string | null => {
  if (value instanceof Error) {
    return value.message;
  }
  return null;
};

// Every error reachable through cause links and AggregateError members, breadth first.
const readErrorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && chain.length < MAX_CHAIN_LINKS) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    chain.push(current);
    if (current instanceof AggregateError) {
      queue.push(...current.errors);
    }
    if (current instanceof Error) {
      queue.push(current.cause);
    }
  }
  return chain;
};

const isD1Link = (link: unknown): boolean =>
  readMessage(link)?.startsWith(D1_MESSAGE_PREFIX) ?? false;

// DrizzleQueryError never sets its name, so it is recognised by class, not by name.
const isDrizzleQueryLink = (link: unknown): boolean => link instanceof DrizzleQueryError;

// One error object, not its chain: for callers that walk error graphs their own way.
const isDatabaseErrorLink = (link: unknown): boolean => isD1Link(link) || isDrizzleQueryLink(link);

const isDatabaseError = (error: unknown): boolean =>
  readErrorChain(error).some((link) => isDatabaseErrorLink(link));

const findD1Message = (error: unknown): string | null => {
  for (const link of readErrorChain(error)) {
    if (isD1Link(link)) {
      return readMessage(link);
    }
  }
  return null;
};

// Only for failures that are safe to retry; null means "not a transient database fault".
const classifyDatabaseError = (error: unknown): DatabaseErrorClassification | null => {
  const message = findD1Message(error);
  if (message === null) {
    return null;
  }
  for (const [pattern, slug] of TRANSIENT_D1_PATTERNS) {
    if (pattern.test(message)) {
      return { slug, sqlState: null };
    }
  }
  return null;
};

const resolveDatabaseErrorClassification = (
  error: unknown,
): DatabaseErrorClassification | null => {
  const classification = classifyDatabaseError(error);
  if (classification !== null) {
    return classification;
  }
  if (!isDatabaseError(error)) {
    return null;
  }
  return { slug: UNCLASSIFIED_DATABASE_SLUG, sqlState: null };
};

/*
 * The D1 message, never the drizzle wrapper's: the wrapper inlines the SQL's bound
 * parameters, which carry calendar data.
 */
const getDatabaseErrorDetails = (error: unknown): DatabaseErrorDetails | null => {
  const message = findD1Message(error);
  if (message === null) {
    return null;
  }
  const constraintMatch = CONSTRAINT_PATTERN.exec(message);
  return {
    constraint: constraintMatch?.[2]?.trim() ?? null,
    detail: constraintMatch?.[1] ?? null,
    message,
    sqlState: null,
  };
};

export {
  classifyDatabaseError,
  getDatabaseErrorDetails,
  isDatabaseError,
  isDatabaseErrorLink,
  resolveDatabaseErrorClassification,
};
export type { DatabaseErrorClassification, DatabaseErrorDetails };
