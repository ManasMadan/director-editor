/**
 * The typed API client, built from the contract in packages/contracts (no server code
 * is imported, so web and mobile type-check fast and can never bundle backend code).
 *
 * Web calls the API on its own origin (`/rpc`), routed by the gateway in deployed
 * environments and by Next rewrites locally, so cookies are first-party and nothing
 * environment-specific is baked into the bundle. Mobile passes an absolute `baseUrl`.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Contract } from "@repo/contracts/api";

export interface ApiClientOptions {
  /** Origin of the API; empty string means "same origin" (web). */
  baseUrl?: string;
  /** Sent as x-app-version so the API can require an update of old apps. */
  appVersion?: string;
  /** Current UI language, sent as x-locale. */
  getLocale?: () => string | undefined;
  /** Extra headers per request (mobile: the session header from the Expo auth plugin). */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

const localeHeader = (locale: string | undefined) => (locale ? { "x-locale": locale } : {});

export function createApiClient(options: ApiClientOptions = {}) {
  const link = new RPCLink({
    url: `${options.baseUrl ?? (typeof window === "undefined" ? "" : window.location.origin)}/rpc`,
    headers: async () => ({
      ...(options.appVersion && { "x-app-version": options.appVersion }),
      ...localeHeader(options.getLocale?.()),
      ...(await options.getHeaders?.()),
    }),
    fetch: (request, init) =>
      (options.fetch ?? fetch)(request, { ...init, credentials: "include" }),
  });
  const client: ContractRouterClient<Contract> = createORPCClient(link);
  return { client, api: createTanstackQueryUtils(client) };
}

export type ApiClient = ReturnType<typeof createApiClient>["client"];
export type ApiUtils = ReturnType<typeof createApiClient>["api"];
