import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { isCalDAVAuthenticationError } from "../../../../src/providers/caldav/source/auth-error-classification";

// What D1 throws: a plain Error whose message carries the "D1_" prefix.
const d1Error = (message: string): Error => new Error(`D1_ERROR: ${message}`);

const EVENT_UPSERT_SQL =
  'insert into "event_states" ("id", "source_event_uid", "title") values (?, ?, ?) '
  + 'on conflict ("id") do update set "title" = excluded."title"';

const upsertFailure = (
  params: unknown[],
  cause: Error,
): DrizzleQueryError => new DrizzleQueryError(EVENT_UPSERT_SQL, params, cause);

const AUTH_TEXT_PARAMS = [
  "state-1",
  "uid-1@fastmail.com",
  "Runbook: authentication failed on the billing gateway",
];

describe("isCalDAVAuthenticationError against our own database failures", () => {
  it("does not read a deadlock on the event upsert as a CalDAV auth failure", () => {
    const error = upsertFailure(
      ["state-1", "uid-1@fastmail.com", "Standup"],
      d1Error("deadlock detected"),
    );

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("does not read an event title mentioning authentication failed as a CalDAV auth failure", () => {
    const error = upsertFailure(
      AUTH_TEXT_PARAMS,
      d1Error("value too long for type character varying(255)"),
    );

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("does not read an event title mentioning invalid credentials as a CalDAV auth failure", () => {
    const error = upsertFailure(
      ["state-1", "uid-1@fastmail.com", "Invalid credentials post-mortem"],
      d1Error("could not serialize access due to concurrent update"),
    );

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("does not read a lost pooled connection as a CalDAV auth failure", () => {
    const error = upsertFailure(
      AUTH_TEXT_PARAMS,
      d1Error("Connection closed"),
    );

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("does not read a database failure nested two wrappers deep as a CalDAV auth failure", () => {
    const error = new Error("source ingest failed", {
      cause: new Error("transaction rolled back", {
        cause: upsertFailure(
          AUTH_TEXT_PARAMS,
          d1Error("deadlock detected"),
        ),
      }),
    });

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("does not read a database failure inside an AggregateError as a CalDAV auth failure", () => {
    const error = new AggregateError(
      [
        upsertFailure(
          AUTH_TEXT_PARAMS,
          d1Error("deadlock detected"),
        ),
      ],
      "ingest batch failed",
    );

    expect(isCalDAVAuthenticationError(error)).toBe(false);
  });

  it("still reads a genuine CalDAV 401 as an auth failure", () => {
    expect(
      isCalDAVAuthenticationError(Object.assign(new Error("Unauthorized"), { status: 401 })),
    ).toBe(true);
  });

  it("returns the same verdict on every repeated evaluation of one incident", () => {
    const verdicts = Array.from({ length: 3 }, () =>
      isCalDAVAuthenticationError(
        upsertFailure(
          AUTH_TEXT_PARAMS,
          d1Error("deadlock detected"),
        ),
      ));

    expect(verdicts).toEqual([false, false, false]);
  });
});
