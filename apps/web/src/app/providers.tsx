"use client";

import { ApiProvider } from "@repo/client";
import type { Locale } from "@repo/i18n";
import { Toaster } from "@repo/ui/components/sonner";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useRouter } from "next/navigation";
import { type AbstractIntlMessages, NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { GUEST_PATHS, matchesPath } from "@/lib/routes";

interface ProvidersProps {
  locale: Locale;
  timeZone: string;
  messages: AbstractIntlMessages;
  nonce: string | undefined;
  children: ReactNode;
}

let switchingWorkspace = false;

/** Every client-side context, mounted once by the root layout. */
export function Providers({ locale, timeZone, messages, nonce, children }: ProvidersProps) {
  const router = useRouter();
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce && { nonce })}
    >
      <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={messages}>
        <ApiProvider
          // No app version: the site always serves its current code, and its release is a
          // build id, not a version the API's update gate could compare.
          options={{ getLocale: () => locale }}
          // The session ended (signed out elsewhere, expired, revoked). Signing out clears
          // the now-useless cookie; otherwise the proxy would still see it and bounce the
          // user from /sign-in back to the dashboard.
          // Several requests can fail together; only one redirect is wanted, and never
          // from an auth page (that would nest ?next= inside ?next=).
          onUnauthenticated={async () => {
            await authClient.signOut();
            const { pathname, search } = window.location;
            if (matchesPath(pathname, GUEST_PATHS)) {
              return;
            }
            router.replace(`/sign-in?next=${encodeURIComponent(pathname + search)}`);
          }}
          onOutdated={() => window.location.reload()}
          // Removed from the active workspace (or it was deleted): move to another one.
          onNoOrganization={async () => {
            // Several requests can fail together; switch once.
            if (switchingWorkspace) {
              return;
            }
            switchingWorkspace = true;
            const { data: workspaces } = await authClient.organization.list();
            const next = workspaces?.[0];
            if (!next) {
              return;
            }
            await authClient.organization.setActive({ organizationId: next.id });
            window.location.assign("/dashboard");
          }}
        >
          {children}
          <Toaster richColors closeButton />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </ApiProvider>
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}
