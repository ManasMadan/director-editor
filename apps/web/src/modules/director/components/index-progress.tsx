"use client";

import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { INDEX_STEPS } from "../lib/library";

/**
 * Gemini at work on a short: what it's doing now, under the loader, and a track of the
 * steps indexing goes through with the current one shimmering. `step` is an index into
 * INDEX_STEPS short of "ready" (a ready or failed plan shows its own state instead).
 */
export function IndexProgress({ step, className }: { step: number; className?: string }) {
  const t = useTranslations("library.stage");
  const current = INDEX_STEPS[step] ?? "queued";
  return (
    <div className={cn("flex flex-col items-center gap-5 text-center", className)}>
      <GeminiLoader label={t(current)} size="lg" />
      {/* The loader announces the step; this is the same words, drawn for the stage. */}
      <p aria-hidden className="-mt-2 font-medium">
        {t(current)}
      </p>
      <ol aria-label={t("label")} className="grid w-full max-w-xs grid-cols-4 gap-1.5">
        {INDEX_STEPS.map((name, index) => (
          <li
            key={name}
            aria-current={index === step ? "step" : undefined}
            className="flex flex-col gap-1.5"
          >
            {index === step ? (
              <GeminiShimmer className="h-1.5 rounded-full bg-studio-foreground/15" />
            ) : (
              <span
                className={cn(
                  "h-1.5 rounded-full",
                  index < step
                    ? "bg-linear-to-r from-aurora-1 via-aurora-2 to-aurora-3"
                    : "bg-studio-foreground/15",
                )}
              />
            )}
            <span
              className={cn(
                "text-[0.7rem]",
                index <= step ? "text-studio-foreground" : "text-studio-foreground/50",
              )}
            >
              {t(`steps.${name}`)}
            </span>
          </li>
        ))}
      </ol>
      <p className="max-w-xs text-sm text-studio-foreground/60">{t("hint")}</p>
    </div>
  );
}
