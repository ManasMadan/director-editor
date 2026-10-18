"use client";

import { useApiErrorMessage } from "@repo/client";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveFailure } from "../hooks/use-director-live";
import type { CaptionStore } from "../lib/caption-store";
import type { Caption } from "../lib/live";
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
 * One line of the conversation, for the eye: Director's beside its orb, the member's on
 * the right. Screen readers hear the lines from the announcement below instead. An older
 * line dims its words only, never its bubble: the glass keeps them at 4.5:1 or better
 * over a bright camera picture.
 */
function Line({ line, older, level }: { line: Caption; older: boolean; level: () => number }) {
  if (line.who === "director") {
    return (
      <div
        className={cn(
          "flex animate-[live-rise_120ms_ease-out_both] items-start gap-2.5 rounded-3xl px-3.5 py-3",
          GLASS,
        )}
      >
        <DirectorOrb level={level} className="mt-0.5 size-7" />
        <p
          className={cn(
            "text-[15px] leading-snug font-semibold text-balance transition-colors duration-300",
            older && "text-studio-foreground/80",
          )}
        >
          {line.text.trim()}
        </p>
      </div>
    );
  }
  return (
    <p
      className={cn(
        "ml-auto max-w-[85%] animate-[live-rise_120ms_ease-out_both] rounded-2xl rounded-br-md bg-studio-foreground/90 px-3 py-1.5 text-sm font-medium text-studio transition-colors duration-300",
        older && "text-studio/75",
      )}
    >
      {line.text.trim()}
    </p>
  );
}

/**
 * The last exchange as captions, oldest first, so a reply always sits under what it
 * answers and the newest line is nearest the text box; the older one is dimmed. The
 * shoot can be followed with the sound off. Screen readers hear each line once, when it's
 * finished, rather than every few words as the transcript streams in.
 */
export function DirectorCaptions({
  captions,
  level,
}: {
  captions: CaptionStore;
  level: () => number;
}) {
  const t = useTranslations("director.live");
  const { captions: shown, working } = useCaptions(captions);
  const { lines } = shown;
  const finished = lines.findLast((line) => line.done);
  return (
    <div className="live-motion flex flex-col gap-1.5">
      <div aria-hidden className="flex flex-col gap-1.5">
        {lines.map((line, at) => (
          <Line key={line.key} line={line} older={at < lines.length - 1} level={level} />
        ))}
      </div>
      {working ? (
        <p role="status" className={cn("self-start rounded-2xl px-3 py-1.5 text-sm", GLASS)}>
          {t(working)}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {finished ? t(finished.who, { text: finished.text.trim() }) : null}
      </p>
    </div>
  );
}

/** The captions as the store has them, re-rendering only what reads them. */
function useCaptions(captions: CaptionStore) {
  return useSyncExternalStore(captions.subscribe, captions.get, captions.get);
}
