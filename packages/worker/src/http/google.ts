import {
  applyCalendarRediscoveryPlan,
  createGoogleOAuthService,
  fetchGoogleUserInfo,
  hasRequiredGoogleScopes,
  toDiscoveredGoogleCalendars,
  validateState,
} from "@keeper.sh/calendar";
import { listUserCalendars } from "@keeper.sh/calendar/google";
import { createSecretCodec } from "@keeper.sh/database";
import type { Database } from "@keeper.sh/database";
import { SINGLE_USER_ID, calendarAccountsTable, oauthCredentialsTable } from "@keeper.sh/database/schema";
import { and, eq } from "drizzle-orm";

// Outcomes of a connect attempt, passed back to the dashboard in its redirect.
type NoticeCode =
  | "connection-added"
  | "connection-reconnected"
  | "google-denied"
  | "google-failed"
  | "google-scopes"
  | "google-unconfigured";
import { createOAuthStateStore } from "./state-store";

/*
 * Connecting Google. The redirect URI must match the Google Cloud OAuth client exactly:
 * https://cal.jeryn.me/api/sources/callback/google. The callback is a GET because OAuth
 * says so; what makes it safe is the single-use state (consumed atomically in D1, ten
 * minutes to live) and that Access stands in front of it like every other route.
 */
const CALLBACK_PATH = "/api/sources/callback/google";
const MS_PER_SECOND = 1000;

interface GoogleContext {
  clientId?: string;
  clientSecret?: string;
  database: Database;
  encryptionKey: string;
  origin: string;
}

const callbackUrl = (origin: string): string => `${origin}${CALLBACK_PATH}`;

const resolveService = (context: GoogleContext) => {
  if (!context.clientId || !context.clientSecret) {
    return null;
  }
  return createGoogleOAuthService(
    { clientId: context.clientId, clientSecret: context.clientSecret },
    createOAuthStateStore(context.database),
  );
};

const startGoogleConnect = async (context: GoogleContext): Promise<string | NoticeCode> => {
  const service = resolveService(context);
  if (!service) {
    return "google-unconfigured";
  }
  return service.getAuthorizationUrl(SINGLE_USER_ID, { callbackUrl: callbackUrl(context.origin) });
};

const storeGoogleAccount = async (
  context: GoogleContext,
  googleUserId: string,
  email: string,
  tokens: { accessToken: string; expiresAt: Date; refreshToken: string | undefined },
): Promise<{ accountId: string; reconnected: boolean } | null> => {
  const codec = createSecretCodec(context.encryptionKey);
  const [existing] = await context.database
    .select({ accountId: calendarAccountsTable.id, credentialId: calendarAccountsTable.oauthCredentialId })
    .from(calendarAccountsTable)
    .where(and(eq(calendarAccountsTable.provider, "google"), eq(calendarAccountsTable.accountId, googleUserId)))
    .limit(1);

  if (existing?.credentialId) {
    await context.database
      .update(oauthCredentialsTable)
      .set({
        accessToken: codec.seal(tokens.accessToken),
        email,
        expiresAt: tokens.expiresAt,
        needsReauthentication: false,
        // Google only sometimes returns a new refresh token; the stored one stays valid otherwise.
        ...(tokens.refreshToken && { refreshToken: codec.seal(tokens.refreshToken) }),
      })
      .where(eq(oauthCredentialsTable.id, existing.credentialId));
    await context.database
      .update(calendarAccountsTable)
      .set({ email, needsReauthentication: false, reauthenticationSource: null })
      .where(eq(calendarAccountsTable.id, existing.accountId));
    return { accountId: existing.accountId, reconnected: true };
  }

  // Without a refresh token Keeper could only work for an hour, so that is a failure.
  if (!tokens.refreshToken) {
    return null;
  }
  const [credential] = await context.database
    .insert(oauthCredentialsTable)
    .values({
      accessToken: codec.seal(tokens.accessToken),
      email,
      expiresAt: tokens.expiresAt,
      provider: "google",
      refreshToken: codec.seal(tokens.refreshToken),
    })
    .returning({ id: oauthCredentialsTable.id });
  const [account] = await context.database
    .insert(calendarAccountsTable)
    .values({
      accountId: googleUserId,
      authType: "oauth",
      displayName: email,
      email,
      oauthCredentialId: credential?.id ?? null,
      provider: "google",
    })
    .returning({ id: calendarAccountsTable.id });
  if (!account) {
    return null;
  }
  return { accountId: account.id, reconnected: false };
};

const completeGoogleConnect = async (context: GoogleContext, url: URL): Promise<NoticeCode> => {
  const service = resolveService(context);
  if (!service) {
    return "google-unconfigured";
  }
  if (url.searchParams.get("error")) {
    return "google-denied";
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !await validateState(createOAuthStateStore(context.database), state)) {
    return "google-failed";
  }
  try {
    const grant = await service.exchangeCodeForTokens(code, callbackUrl(context.origin));
    if (!hasRequiredGoogleScopes(grant.scope)) {
      return "google-scopes";
    }
    const user = await fetchGoogleUserInfo(grant.access_token);
    const stored = await storeGoogleAccount(context, user.id, user.email, {
      accessToken: grant.access_token,
      expiresAt: new Date(Date.now() + grant.expires_in * MS_PER_SECOND),
      refreshToken: grant.refresh_token,
    });
    if (!stored) {
      return "google-failed";
    }
    const calendars = await listUserCalendars(grant.access_token);
    await applyCalendarRediscoveryPlan(context.database, {
      accountId: stored.accountId,
      caldavServerHost: null,
      calendarType: "oauth",
      discovered: toDiscoveredGoogleCalendars(calendars),
      now: new Date(),
      userId: SINGLE_USER_ID,
    });
    if (stored.reconnected) {
      return "connection-reconnected";
    }
    return "connection-added";
  } catch {
    return "google-failed";
  }
};

export { CALLBACK_PATH, completeGoogleConnect, startGoogleConnect };
export type { GoogleContext };
