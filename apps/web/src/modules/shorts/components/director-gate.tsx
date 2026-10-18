"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { useMeQuery } from "@repo/client/api/user/me";
import { buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Its children once the API says Director is on; why not otherwise. */
export function DirectorGate({ children }: { children: ReactNode }) {
  const t = useTranslations("director");
  const system = useSystemInfoQuery();
  // The system info is public, so with Director off nothing on the page would ask the API
  // as the member: an ended session would then never answer 401, and the app's redirect
  // to sign-in would never run. Asking who they are checks the session either way.
  useMeQuery();
  if (system.isPending) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center">
        <GeminiLoader label={t("starting")} size="lg" />
      </div>
    );
  }
  if (!system.data?.features.director) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-studio-foreground/80">{t("off")}</p>
        <Link href="/settings" className={buttonVariants({ variant: "secondary" })}>
          {t("leave")}
        </Link>
      </div>
    );
  }
  return children;
}
