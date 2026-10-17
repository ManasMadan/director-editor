"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { buttonVariants } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Its children once the API says Director is on; why not otherwise. */
export function DirectorGate({ children }: { children: ReactNode }) {
  const t = useTranslations("shorts");
  const system = useSystemInfoQuery();
  if (system.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!system.data?.features.director) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-studio-foreground/80">{t("off")}</p>
        <Link href="/settings" className={buttonVariants({ variant: "secondary" })}>
          {t("leave")}
        </Link>
      </div>
    );
  }
  return children;
}
