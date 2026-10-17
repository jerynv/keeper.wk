import { createDatabase } from "@keeper.sh/database";
import { routeApi } from "../api/routes";
import type { Env } from "../env";
import { authenticateRequest, forbidden } from "./access";
import { privacyPage } from "./privacy";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/*
 * A browser sends Origin on every state-changing request. Requiring it to be this site
 * stops another page from driving the API with the owner's Access cookie.
 */
const isSameOrigin = (request: Request): boolean =>
  request.headers.get("origin") === new URL(request.url).origin;

const withApiHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

/*
 * Access first, for every request, the dashboard's own files included: nothing below
 * runs for a request Access did not vouch for. Then /api goes to the API, and every
 * other path is the dashboard (applications/web), a single-page app.
 */
const handleRequest = async (request: Request, env: Env): Promise<Response> => {
  if (new URL(request.url).pathname === "/privacy" && request.method === "GET") {
    return privacyPage();
  }
  const identity = await authenticateRequest(request, {
    audience: env.ACCESS_AUD,
    ownerEmail: env.OWNER_EMAIL,
    teamDomain: env.ACCESS_TEAM_DOMAIN,
  });
  if (!identity) {
    return forbidden();
  }
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    return env.ASSETS.fetch(request);
  }
  if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
    return forbidden();
  }
  const response = await routeApi({
    database: createDatabase(env.DB),
    encryptionKey: env.ENCRYPTION_KEY,
    env,
    origin: env.PUBLIC_ORIGIN || url.origin,
    queue: env.SYNC_QUEUE,
    request,
    url,
  });
  return withApiHeaders(response);
};

export { handleRequest };
