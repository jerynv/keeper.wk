import type { Env } from "./env";

// The settings page and its API arrive in Phase 5; until then nothing is served.
const handleRequest = (_request: Request, _env: Env): Promise<Response> =>
  Promise.resolve(new Response("Not found", { status: 404 }));

export { handleRequest };
