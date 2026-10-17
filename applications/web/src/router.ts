import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./generated/tanstack/route-tree.generated";
import { createJsonFetcher } from "./lib/json-fetcher";
import { getPublicRuntimeConfig, getServerPublicRuntimeConfig } from "./lib/runtime-config";
import type { PublicRuntimeConfig } from "./lib/runtime-config";
import type { AppRouterContext } from "./lib/router-context";

import type { ViteAssets } from "./lib/router-context";

interface CreateAppRouterOptions {
  request?: Request;
  viteAssets?: ViteAssets;
}

function getConfiguredApiOrigin(): string | undefined {
  if (typeof window === "undefined") {
    return process.env.VITE_API_URL;
  }

  return import.meta.env.VITE_API_URL;
}

function resolveApiOrigin(request: Request | undefined): string {
  const configuredApiOrigin = getConfiguredApiOrigin();
  if (configuredApiOrigin && configuredApiOrigin.length > 0) {
    return configuredApiOrigin;
  }

  if (request) {
    return new URL(request.url).origin;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  throw new Error("Unable to resolve API origin.");
}

function resolveWebOrigin(request: Request | undefined): string {
  if (request) {
    return new URL(request.url).origin;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  throw new Error("Unable to resolve web origin.");
}

function createApiFetcher(
  request: Request | undefined,
): AppRouterContext["fetchApi"] {
  const requestCookie = request?.headers.get("cookie") ?? null;
  const apiOrigin = resolveApiOrigin(request);
  return createJsonFetcher(requestCookie, apiOrigin);
}

function createWebFetcher(
  request: Request | undefined,
): AppRouterContext["fetchWeb"] {
  const requestCookie = request?.headers.get("cookie") ?? null;
  const webOrigin = resolveWebOrigin(request);
  return createJsonFetcher(requestCookie, webOrigin);
}

function resolveRuntimeConfig(request: Request | undefined): PublicRuntimeConfig {
  if (request) {
    return getServerPublicRuntimeConfig({ environment: process.env });
  }

  return getPublicRuntimeConfig();
}

// Cloudflare Access admits only the owner before this page loads, so a session exists.
function createSessionChecker(): () => boolean {
  return () => true;
}

function buildRouterContext(
  request: Request | undefined,
  viteAssets: ViteAssets | undefined,
): AppRouterContext {
  return {
    auth: {
      hasSession: createSessionChecker(),
    },
    fetchApi: createApiFetcher(request),
    fetchWeb: createWebFetcher(request),
    runtimeConfig: resolveRuntimeConfig(request),
    viteAssets: viteAssets ?? null,
  };
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  const router = createRouter({
    context: buildRouterContext(options.request, options.viteAssets),
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: true,
    scrollToTopSelectors: ["body"],
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
