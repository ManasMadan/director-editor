"use client";

import { Button, buttonVariants } from "@repo/ui/components/button";
import Link from "next/link";
import { useTranslations } from "next-intl";

/** A page crashed while rendering. `digest` matches the server log entry for it. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  return (
    <section className="flex flex-col items-start gap-4 py-16" role="alert">
      <h1 className="text-3xl font-semibold tracking-tight">{t("errorPage.errorTitle")}</h1>
      <p className="text-muted-foreground">{t("errorPage.errorDescription")}</p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">
          {t("common.requestId", { requestId: error.digest })}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={reset}>{t("common.retry")}</Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          {t("errorPage.home")}
        </Link>
      </div>
    </section>
  );
}
