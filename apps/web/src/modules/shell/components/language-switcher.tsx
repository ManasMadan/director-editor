"use client";

import { locales } from "@repo/i18n/locales";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { LanguagesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { setPreferenceCookie } from "@/lib/cookies";

/** Each language is named in itself ("Español"), so everyone can find theirs. */
// A language code the browser doesn't know comes back as the code itself.
const nativeName = (locale: string) =>
  String(new Intl.DisplayNames([locale], { type: "language" }).of(locale));

export function LanguageSwitcher() {
  const t = useTranslations("common");
  const current = useLocale();
  const router = useRouter();
  const { data: session, refetch } = authClient.useSession();

  async function choose(locale: string) {
    // Signed-in users keep the choice everywhere (emails, other devices). Save it and
    // reload the session first: PreferenceSync treats the saved language as the truth.
    if (session) {
      await authClient.updateUser({ locale });
      await refetch();
    }
    setPreferenceCookie("locale", locale);
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={t("language")} />}
      >
        <LanguagesIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => choose(locale)}
            aria-current={locale === current}
          >
            {nativeName(locale)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
