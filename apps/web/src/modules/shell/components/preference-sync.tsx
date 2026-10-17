"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { setPreferenceCookie } from "@/lib/cookies";

/**
 * Keeps the time zone cookie the server renders with (src/i18n/request.ts) at the
 * browser's, so dates match the clock on the user's screen. Renders nothing. English is
 * the only language, so there is no saved language to follow yet: a second one would
 * bring back syncing the account's choice here.
 */
export function PreferenceSync({ timeZone }: { timeZone: string }) {
  const router = useRouter();

  useEffect(() => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserZone && browserZone !== timeZone) {
      setPreferenceCookie("tz", browserZone);
      router.refresh();
    }
  }, [timeZone, router]);

  return null;
}
