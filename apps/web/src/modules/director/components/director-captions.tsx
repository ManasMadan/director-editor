"use client";

import { useApiErrorMessage } from "@repo/client";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { LiveFailure } from "../hooks/use-director-live";
import type { Captions } from "../lib/live";
import { GLASS } from "./shoot-parts";

const prefersStill = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The failures Director has its own words for; any other code reads as the API's own
 * message for it (`errors.<CODE>`).
 */
const TOLD_FAILURES = [
  "dropped",
  "INTERNAL",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
  "CONFLICT",
  "TIMEOUT",
  "FEATURE_DISABLED",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_SHOT_NOT_FOUND",
  "UNAUTHENTICATED",
] as const;

/** Why Director couldn't join or stay, in the member's words. */
export function useLiveFailure() {
  const t = useTranslations("director.live.failed");
  const apiError = useApiErrorMessage();
  return (failure: LiveFailure) => {
    const told = TOLD_FAILURES.find((known) => known === failure);
    return told ? t(told) : apiError({ code: failure });
  };
}

/**
 * Director: an aurora orb that swells with its voice, read from `level` every frame
 * (straight onto the element, so a voice doesn't re-render the screen sixty times a
 * second). Held still for anyone who prefers less motion.
 */
export function DirectorOrb({ level, className }: { level: () => number; className?: string }) {
  const orb = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (prefersStill()) {
      return;
    }
    let frame = 0;
    const draw = () => {
      orb.current?.style.setProperty("--level", level().toFixed(3));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <span
      ref={orb}
      aria-hidden
      className={cn(
        "live-motion relative flex shrink-0 scale-[calc(1+var(--level,0)*0.45)] transition-transform duration-75",
        className,
      )}
    >
      <span className="absolute -inset-1 rounded-full bg-[conic-gradient(from_0deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))] opacity-[calc(0.35+var(--level,0)*0.65)] blur-md" />
      <span className="absolute inset-0 animate-[live-drift_4s_linear_infinite] rounded-full bg-[conic-gradient(from_90deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))]" />
      <span className="absolute inset-[3px] rounded-full bg-studio/35 backdrop-blur-sm" />
    </span>
  );
}

/**
 * Both sides of the conversation as captions: Director's last line beside its orb, and
 * the member's own words as Director heard them (or as they typed them). Read out as
 * they change, so following the shoot never needs the sound on.
 */
export function DirectorCaptions({ captions, level }: { captions: Captions; level: () => number }) {
  const t = useTranslations("director.live");
  const { director, you } = captions;
  return (
    <div className="live-motion flex flex-col gap-1.5" aria-live="polite">
      {director ? (
        <div
          key={director.key}
          className={cn(
            "flex animate-[live-rise_300ms_ease-out_both] items-start gap-2.5 rounded-3xl px-3.5 py-3",
            GLASS,
          )}
        >
          <DirectorOrb level={level} className="mt-0.5 size-7" />
          <p className="text-[15px] leading-snug font-semibold text-balance">
            <span className="sr-only">{t("director")} </span>
            {director.text.trim()}
          </p>
        </div>
      ) : null}
      {you ? (
        <p
          key={you.key}
          className="ml-auto max-w-[85%] animate-[live-rise_250ms_ease-out_both] rounded-2xl rounded-br-md bg-studio-foreground/90 px-3 py-1.5 text-sm font-medium text-studio"
        >
          <span className="sr-only">{t("you")} </span>
          {you.text.trim()}
        </p>
      ) : null}
    </div>
  );
}
