"use client";

import { cn } from "@repo/ui/lib/utils";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DirectorLive } from "../hooks/use-director-live";
import { GLASS } from "./shoot-parts";

/**
 * Director is on the slower line (Live couldn't start, or dropped twice): a small pill
 * under the indicator that says so, and Reconnect to bring Live back. Director explains
 * the slower answers itself, in its own words.
 */
export function SlowerLinePill({ live }: { live: DirectorLive }) {
  const t = useTranslations("director.live");
  return (
    <div
      role="status"
      className={cn(
        "flex w-fit items-center gap-1 rounded-full py-0.5 pr-0.5 pl-3 text-sm font-semibold",
        GLASS,
      )}
    >
      <span>{t("slower")}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={live.reconnect}
        className="min-h-11 rounded-full px-3 underline-offset-2 hover:underline"
      >
        {t("reconnect")}
      </button>
    </div>
  );
}

/**
 * Gemini is out of reach: Director is silent, and says so in a banner. Filming carries
 * on; the footage is sorted once Gemini is back. Try again brings Director back as soon
 * as it can be had.
 */
export function AwayBanner({ live }: { live: DirectorLive }) {
  const t = useTranslations("director.live");
  return (
    <div role="alert" className={cn("rounded-2xl px-3.5 py-2.5 text-sm", GLASS)}>
      <p className="font-semibold">{t("away")}</p>
      <button
        type="button"
        onClick={live.reconnect}
        className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-full bg-studio-foreground px-4 text-sm font-semibold text-studio"
      >
        <RefreshCw className="size-4" aria-hidden />
        {t("retry")}
      </button>
    </div>
  );
}
