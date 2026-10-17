import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { SWRConfig } from "swr";
import { Heading2 } from "@/components/ui/primitives/heading";
import { Text } from "@/components/ui/primitives/text";
import { LinkButton, ButtonText } from "@/components/ui/primitives/button";
import { NotFoundState } from "@/components/ui/shells/not-found";
import { fetcher, HttpError } from "@/lib/fetcher";
import { resolveErrorMessage } from "@/utils/errors";
import type { AppRouterContext } from "@/lib/router-context";

const NON_RETRYABLE_STATUSES = new Set([401, 403, 404]);

const SWR_CONFIG = {
  fetcher,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 2000,
  onError: (error: unknown, key: string) => {
    console.error(`[SWR] ${key}:`, error);
  },
  onErrorRetry: (
    error: unknown,
    _key: string,
    _config: unknown,
    revalidate: (opts: { retryCount: number }) => void,
    { retryCount }: { retryCount: number },
  ) => {
    if (error instanceof HttpError && NON_RETRYABLE_STATUSES.has(error.status)) return;
    if (retryCount >= 3) return;
    setTimeout(() => revalidate({ retryCount }), 5000 * (retryCount + 1));
  },
};

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundState,
  errorComponent: ErrorFallback,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Keeper.sh" },
    ],
  }),
});

// Rendered into #root by main.tsx: the document shell lives in index.html.
function RootComponent() {
  return (
    <SWRConfig value={SWR_CONFIG}>
      <Outlet />
    </SWRConfig>
  );
}

function ErrorFallback({ error }: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-2 gap-3">
      <meta name="robots" content="noindex" />
      <Heading2>Something went wrong</Heading2>
      <Text size="sm" tone="muted">
        {resolveErrorMessage(error, "An unexpected error occurred.")}
      </Text>
      <LinkButton to="/" variant="border" size="compact">
        <ButtonText>Go home</ButtonText>
      </LinkButton>
    </div>
  );
}
