/**
 * Renders a page the way the app does: inside the real providers (the API client against
 * the test API, next-intl with the real messages, the theme), with a stand-in for the
 * Next.js router, which only exists inside a Next server. Client-side navigations
 * (`router.push`, `<Link>`) change the test page's URL like the real router, without
 * loading another page; full-page ones are caught by the `startTest` command.
 *
 *   const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
 *   await userEvent.click(page.getByRole("button", { name: "Sign in" }));
 *   await expect.poll(currentUrl).toBe("/settings");
 */
// The app's styles, as the root layout loads them: components are laid out for real.
import "@repo/ui/globals.css";
import type { Locale } from "@repo/i18n";
import { bundledMessages } from "@repo/i18n";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { usePathname } from "next/navigation";
import type { NextRouter } from "next/router";
import { type ReactNode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { page } from "vitest/browser";
import { Providers } from "@/app/providers";
import { authClient } from "@/lib/auth-client";

const mounted: { root: Root; container: HTMLElement }[] = [];

/** The test page's path and query, as the app sees them. */
export const currentUrl = () => window.location.pathname + window.location.search;

/** How many times the page asked the router to refresh server components. */
export const router = { refreshes: 0 };

function TestRouter({ children }: { children: ReactNode }) {
  const [url, setUrl] = useState(currentUrl);
  const go = (method: "pushState" | "replaceState") => (href: string) => {
    window.history[method](null, "", href);
    setUrl(currentUrl());
  };
  const app: AppRouterInstance = {
    push: go("pushState"),
    replace: go("replaceState"),
    refresh: () => {
      router.refreshes += 1;
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    // <Link> prefetches on hover and expects a promise; there's nothing to prefetch here.
    prefetch: () => Promise.resolve() as unknown as undefined,
    bfcacheId: "test",
  };
  const parsed = new URL(url, window.location.origin);
  return (
    <AppRouterContext value={app}>
      {/* <Link> reads the Pages Router's context outside Next's own bundling. */}
      <RouterContext value={app as unknown as NextRouter}>
        <PathnameContext value={parsed.pathname}>
          <SearchParamsContext value={parsed.searchParams}>{children}</SearchParamsContext>
        </PathnameContext>
      </RouterContext>
    </AppRouterContext>
  );
}

/**
 * The auth client keeps its session for the life of the test page, while tests sign
 * people in and out with plain requests: give it the page's current one before
 * rendering. Bumping its signal afterwards drops any older fetch still in flight.
 */
async function syncSession() {
  const { data } = await authClient.getSession({ query: { disableCookieCache: true } });
  const session = authClient.$store.atoms.session as unknown as {
    get(): object;
    set(value: object): void;
  };
  session.set({ ...session.get(), data, error: null, isPending: false, isRefetching: false });
  authClient.$store.notify("$sessionSignal");
}

/** The page, while the URL is still on it: navigating to another path leaves it, as in the app. */
function Route({ path, children }: { path: string; children: ReactNode }) {
  return usePathname() === path ? children : null;
}

export async function renderPage(
  ui: ReactNode,
  options: { url?: string; locale?: Locale; timeZone?: string } = {},
) {
  const locale = options.locale ?? "en";
  window.history.replaceState(null, "", options.url ?? "/");
  const path = window.location.pathname;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const messages = await bundledMessages.load(locale);
  await syncSession();
  flushSync(() =>
    root.render(
      <TestRouter>
        <Providers
          locale={locale}
          timeZone={options.timeZone ?? "UTC"}
          messages={messages}
          nonce={undefined}
        >
          <Route path={path}>{ui}</Route>
        </Providers>
      </TestRouter>,
    ),
  );
  return page;
}

/** Unmounts what the test rendered (setup.ts calls it after each test). */
export function cleanup() {
  // Toasts live in sonner's module state: without this, the next test's Toaster shows them.
  toast.dismiss();
  for (const { root, container } of mounted.splice(0)) {
    root.unmount();
    container.remove();
  }
  router.refreshes = 0;
}
