"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";

/**
 * Whether the signed-in account is the demo (the shared account or a demo guest), whose
 * name, picture, email and security the API refuses to change (apps/api
 * src/auth/demo.ts); undefined until the session says. Those settings are never offered
 * to it, rather than refused after they're tried.
 */
export function useDemoAccount(): boolean | undefined {
  const { data, isPending } = authClient.useSession();
  return isPending ? undefined : data?.user.demo === true;
}

/** Why the demo's settings offer so little, at the top of each settings page. */
export function DemoSettingsNote() {
  const t = useTranslations("settings");
  return (
    <Alert>
      <AlertDescription>{t("demoLocked")}</AlertDescription>
    </Alert>
  );
}
