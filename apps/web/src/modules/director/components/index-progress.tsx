"use client";

import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { INDEX_STEPS, type IndexStep } from "../lib/library";
import { timecode } from "../lib/track";

// Anything that takes longer than this says it's still working (the quality bar).
const STILL_WORKING_AFTER_S = 10;
// Indexing a Short usually takes one to three minutes: past this, it says it's slow.
const LONGER_THAN_USUAL_S = 240;

/** Seconds since `since`, ticking every second; null without a start. */
function useSecondsSince(since: Date | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [since]);
  return since ? Math.max(0, (now - since.getTime()) / 1000) : null;
}

/** How long it's been at it, once that's worth saying, and whether that's slow. */
function Elapsed({ seconds }: { seconds: number | null }) {
  const t = useTranslations("library.stage");
  if (seconds === null || seconds < STILL_WORKING_AFTER_S) {
    return null;
  }
  const elapsed = timecode(seconds);
  return (
    <p className="text-sm font-medium tabular-nums">
      {seconds < LONGER_THAN_USUAL_S ? t("stillWorking", { elapsed }) : t("longer", { elapsed })}
    </p>
  );
}

/**
 * Gemini at work on a short: what it's doing now, under the loader, and a track of the
 * steps indexing goes through with the current one shimmering, and, from ten seconds in,
 * how long the current step has been going (`since`, when it started). A ready or failed
 * plan shows its own state instead.
 */
export function IndexProgress({
  step: current,
  since,
  className,
}: {
  step: IndexStep;
  since?: Date;
  className?: string;
}) {
  const t = useTranslations("library.stage");
  const step = INDEX_STEPS.indexOf(current);
  const seconds = useSecondsSince(since);
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
      <Elapsed seconds={seconds} />
      <p className="max-w-xs text-sm text-studio-foreground/60">{t("hint")}</p>
    </div>
  );
}
