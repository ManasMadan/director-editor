/**
 * Provides the API client and TanStack Query to a React tree (web and mobile).
 *
 *   <ApiProvider options={{ appVersion }} onUnauthenticated={() => router.replace("/sign-in")}>
 *
 * Global behaviour lives here, once:
 * - any UNAUTHENTICATED error (session expired, signed out elsewhere, revoked) empties
 *   every cached query, so no previous user's data stays on screen, without refetching
 *   the ones still mounted, and calls `onUnauthenticated`;
 * - CLIENT_OUTDATED calls `onOutdated` (show "please update");
 * - NO_ACTIVE_ORGANIZATION (the active workspace was deleted, or the user was removed
 *   from it) calls `onNoOrganization`, where the app switches to another workspace;
 * - retries only errors that can succeed on retry (network, 5xx), never 4xx.
 */
import {
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createContext, type ReactNode, use, useState } from "react";
import { type ApiClient, type ApiClientOptions, type ApiUtils, createApiClient } from "./client";
import { errorCode } from "./errors";

interface ApiContextValue {
  client: ApiClient;
  api: ApiUtils;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps {
  options?: ApiClientOptions;
  onUnauthenticated?: () => void | Promise<void>;
  onOutdated?: () => void;
  onNoOrganization?: () => void | Promise<void>;
  children: ReactNode;
}

const RETRYABLE = new Set(["SERVICE_UNAVAILABLE", "INTERNAL", "UPSTREAM_UNAVAILABLE"]);

export function ApiProvider({
  options,
  onUnauthenticated,
  onOutdated,
  onNoOrganization,
  children,
}: ApiProviderProps) {
  const [value] = useState<ApiContextValue & { queryClient: QueryClient }>(() => {
    const handle = (error: unknown, failed?: Query<unknown, unknown, unknown>) => {
      const code = errorCode(error);
      if (code === "UNAUTHENTICATED") {
        forgetSession(queryClient, failed);
        void onUnauthenticated?.();
      } else if (code === "CLIENT_OUTDATED") {
        onOutdated?.();
      } else if (code === "NO_ACTIVE_ORGANIZATION") {
        void onNoOrganization?.();
      }
    };
    const queryClient: QueryClient = new QueryClient({
      queryCache: new QueryCache({ onError: (error, query) => handle(error, query) }),
      mutationCache: new MutationCache({ onError: (error) => handle(error) }),
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          retry: (count, error) => RETRYABLE.has(errorCode(error)) && count < 2,
        },
        mutations: { retry: false },
      },
    });
    return { ...createApiClient(options), queryClient };
  });

  return (
    <QueryClientProvider client={value.queryClient}>
      <ApiContext value={value}>{children}</ApiContext>
    </QueryClientProvider>
  );
}

/**
 * Empties every cached answer. Not with `queryClient.clear()`: a query still on screen
 * would build a fresh entry and refetch at once, fail the same way and clear again, over
 * and over until the app had navigated away. Emptied in place, a query waits for its
 * next mount or focus to ask again; the one that failed keeps its error.
 */
function forgetSession(queryClient: QueryClient, failed?: Query<unknown, unknown, unknown>) {
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query === failed) {
      query.setState({ ...query.state, data: undefined });
    } else {
      query.reset();
    }
  }
  // Mutations stay: one that failed this way still owes its caller the error, to show
  // ("Please sign in to continue"), and none of them fetches again on its own.
}

/** The typed client and query utilities. Hooks in `api/*` use this; apps rarely need it. */
export function useApi(): ApiContextValue {
  const value = use(ApiContext);
  if (!value) {
    throw new Error("useApi must be used inside <ApiProvider>");
  }
  return value;
}
