"use client";

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";

/** better-auth's "this needs a recent sign-in" answer (see freshAge in apps/api). */
export const needsRecentSignIn = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "SESSION_NOT_FRESH";

/**
 * Shown in place of a sensitive section when the session is older than the API's
 * fresh-session window. Signing in again returns the user to this page.
 */
export function ReauthPrompt() {
  const t = useTranslations("settings.security.reauth");
  const router = useRouter();
  const queryClient = useQueryClient();

  async function signInAgain() {
    const next = window.location.pathname;
    await authClient.signOut();
    queryClient.clear();
    router.replace(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  return (
    <Alert>
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        {t("body")}
        <Button size="sm" onClick={signInAgain}>
          {t("action")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
