import { beforeEach, describe, expect, it } from "vitest";
import { widelog, widelogger } from "../../../src/core/telemetry/widelog";
import { createSecretCodec } from "@keeper.sh/database";
import type { Database as BunSQLDatabase } from "@keeper.sh/database";
import { createCoordinatedRefresher } from "../../../src/core/oauth/coordinated-refresher";

// 32 zero bytes, base64: a fixed key so the test needs no secret.
const TOKEN_CODEC = createSecretCodec("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

interface EmittedEvent {
  outcome?: string;
  token?: { persist_attempts?: number; rotation_lost?: boolean };
}

const emitted: EmittedEvent[] = [];

const { context } = widelogger({
  defaultEventName: "wide_event",
  environment: "production",
  service: "calendar-test",
  transport: (event) => {
    emitted.push(event as EmittedEvent);
  },
});

beforeEach(() => {
  emitted.length = 0;
});

// D1's documented retryable failure, wrapped the way drizzle surfaces a failed query.
const transientD1Failure = (): Error =>
  new Error("Failed query", { cause: new Error("D1_ERROR: Network connection lost.") });

const constraintViolation = (): Error => new Error("duplicate key value violates unique constraint");

interface Persistence {
  attempts: number;
  stored: Record<string, unknown>[];
}

const createDatabase = (
  failures: number,
  failureOf: () => Error,
): { database: BunSQLDatabase; persistence: Persistence } => {
  const persistence: Persistence = { attempts: 0, stored: [] };
  const database = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          persistence.attempts += 1;
          if (persistence.attempts <= failures) {
            return Promise.reject(failureOf());
          }
          persistence.stored.push(values);
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as BunSQLDatabase;
  return { database, persistence };
};

const grantOf = (rotatedToken: string | null) => {
  if (rotatedToken === null) {
    return { access_token: "fresh-access", expires_in: 3600 };
  }
  return { access_token: "fresh-access", expires_in: 3600, refresh_token: rotatedToken };
};

const refresh = async (
  database: BunSQLDatabase,
  rotatedToken: string | null,
): Promise<string | null> => {
  const refresher = createCoordinatedRefresher({
    calendarAccountId: "account-1",
    database,
    oauthCredentialId: "credential-under-test",
    rawRefresh: () => Promise.resolve(grantOf(rotatedToken)),
    refreshLockStore: null,
    tokenCodec: TOKEN_CODEC,
  });
  const failures: string[] = [];
  await context(async () => {
    try {
      await refresher("stored-refresh-token");
    } catch (error) {
      failures.push(String(error));
      widelog.set("outcome", "error");
    } finally {
      widelog.flush();
    }
  });
  return failures[0] ?? null;
};

const eventWithToken = (): EmittedEvent["token"] =>
  emitted.find(({ token }) => Boolean(token))?.token;

describe("persisting a refreshed credential", () => {
  it("keeps the rotated token when a transient write fails and then succeeds", async () => {
    const { database, persistence } = createDatabase(2, transientD1Failure);

    const failure = await refresh(database, "rotated-refresh-token");

    expect(failure).toBeNull();
    expect(persistence.attempts).toBe(3);
    // Stored sealed, and it is the rotated token once opened.
    const stored = persistence.stored[0] ?? {};
    expect(stored.refreshToken).not.toBe("rotated-refresh-token");
    expect(stored.accessToken).not.toBe("fresh-access");
    expect(TOKEN_CODEC.open(String(stored.refreshToken))).toBe("rotated-refresh-token");
    expect(TOKEN_CODEC.open(String(stored.accessToken))).toBe("fresh-access");
    expect(eventWithToken()?.persist_attempts).toBe(3);
  });

  it("does not retry a failure the database will answer the same way", async () => {
    const { database, persistence } = createDatabase(1, constraintViolation);

    const failure = await refresh(database, "rotated-refresh-token");

    expect(failure).toContain("duplicate key");
    expect(persistence.attempts).toBe(1);
  });

  it("reports a rotated token as lost once the retries are spent", async () => {
    const { database } = createDatabase(Number.MAX_SAFE_INTEGER, transientD1Failure);

    const failure = await refresh(database, "rotated-refresh-token");

    expect(failure).toContain("Failed query");
    expect(eventWithToken()?.rotation_lost).toBe(true);
  });

  it("reports no loss when the provider did not rotate the token", async () => {
    const { database } = createDatabase(Number.MAX_SAFE_INTEGER, transientD1Failure);

    await refresh(database, null);

    expect(eventWithToken()?.rotation_lost).toBe(false);
  });
});
