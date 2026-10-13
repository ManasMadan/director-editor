"use client";

import { isLocale } from "@repo/i18n/locales";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { setPreferenceCookie } from "@/lib/cookies";

/**
 * Keeps the preference cookies the server renders with (src/i18n/request.ts) in line
 * with reality. Renders nothing.
 *
 * - Language: once signed in, the account's saved language wins, so signing in on a new
 *   device shows the language the user chose rather than the browser's.
 * - Time zone: the browser's, so dates match the clock on the user's screen.
 */
export function PreferenceSync({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  const locale = useLocale();
  const { data: session } = authClient.useSession();
  const savedLocale = session?.user.locale;

  useEffect(() => {
    let changed = false;
    if (isLocale(savedLocale) && savedLocale !== locale) {
      setPreferenceCookie("locale", savedLocale);
      changed = true;
    }
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserZone && browserZone !== timeZone) {
      setPreferenceCookie("tz", browserZone);
      changed = true;
    }
    if (changed) {
      router.refresh();
    }
  }, [savedLocale, locale, timeZone, router]);

  return null;
}
