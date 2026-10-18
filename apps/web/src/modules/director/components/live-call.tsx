"use client";

import { useApiErrorMessage } from "@repo/client";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import type { CallFailure, CallState } from "../hooks/use-live-call";
import type { Captions } from "../lib/live-call";
import { GLASS } from "./live-hud";

const prefersStill = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The failures a call has its own words for; any other code reads as the API's own
 * message for it (`errors.<CODE>`).
 */
const TOLD_FAILURES = [
  "microphone",
  "dropped",
  "RATE_LIMITED",
  "CONFLICT",
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_SHOT_NOT_FOUND",
  "UNAUTHENTICATED",
] as const;

/** Why a call failed, in the member's words. */
export function useCallFailure() {
  const t = useTranslations("director.call.failed");
  const apiError = useApiErrorMessage();
  return (failure: CallFailure) => {
    const told = TOLD_FAILURES.find((known) => known === failure);
    return told ? t(told) : apiError({ code: failure });
  };
}

/**
 * Director on the call: an aurora orb that swells with its voice, read from `level` every
 * frame (straight onto the element, so a voice doesn't re-render the screen sixty times a
 * second). Held still for anyone who prefers less motion.
 */
export function CallOrb({ level, className }: { level: () => number; className?: string }) {
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
 * The header's word on the call: ringing, or on the call with Director's orb. Each is
 * said once: the ringing by the loader's own status, reaching Director by the pill's
 * live region (the ringing's visible words stay out of it).
 */
export function CallPill({ state, level }: { state: CallState; level: () => number }) {
  const t = useTranslations("director.call");
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-full py-1 pr-3.5 pl-1.5 text-sm font-semibold",
        GLASS,
      )}
    >
      {state === "live" ? (
        <>
          <CallOrb level={level} className="size-6" />
          <span>{t("live")}</span>
        </>
      ) : (
        <>
          <GeminiLoader size="sm" label={t("connecting")} />
          <span aria-hidden="true">{t("connecting")}</span>
        </>
      )}
    </div>
  );
}

/**
 * Both sides of the conversation as captions at the foot of the viewport: Director's last
 * line beside its orb, and the member's own words as Director heard them.
 */
export function CallCaptions({ captions, level }: { captions: Captions; level: () => number }) {
  const t = useTranslations("director.call");
  const { director, you } = captions;
  return (
    <div className="live-motion flex flex-col gap-1.5" aria-live="polite">
      {director ? (
        <div
          key={director.key}
          className={cn(
            "flex animate-[live-rise_380ms_cubic-bezier(.2,.8,.2,1)_both] items-start gap-2.5 rounded-3xl px-3.5 py-3",
            GLASS,
          )}
        >
          <CallOrb level={level} className="mt-0.5 size-7" />
          <p className="text-[15px] leading-snug font-semibold text-balance">
            <span className="sr-only">{t("director")} </span>
            {director.text.trim()}
          </p>
        </div>
      ) : null}
      {you ? (
        <p
          key={you.key}
          className="ml-auto max-w-[85%] animate-[live-rise_300ms_ease-out_both] rounded-2xl rounded-br-md bg-studio-foreground/90 px-3 py-1.5 text-sm font-medium text-studio"
        >
          <span className="sr-only">{t("you")} </span>
          {you.text.trim()}
        </p>
      ) : null}
    </div>
  );
}

/** The button that rings Director, in the dock beside the shutter. */
export function CallButton({ onCall, ref }: { onCall: () => void; ref?: Ref<HTMLButtonElement> }) {
  const t = useTranslations("director.call");
  return (
    <button
      ref={ref}
      type="button"
      onClick={onCall}
      aria-label={t("start")}
      title={t("start")}
      className="relative flex size-12 items-center justify-center rounded-full transition-transform duration-200 active:scale-90"
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))]"
      />
      <span aria-hidden className="absolute inset-[2px] rounded-full bg-studio/70" />
      <Phone className="relative size-5" aria-hidden />
    </button>
  );
}

/** The dock during a call: mute, the shutter, and hang up. */
export function CallDock({
  shutter,
  muted,
  canMute,
  onMute,
  onEnd,
  endRef,
}: {
  shutter: ReactNode;
  muted: boolean;
  canMute: boolean;
  onMute: () => void;
  onEnd: () => void;
  endRef?: Ref<HTMLButtonElement>;
}) {
  const t = useTranslations("director.call");
  const mute = muted ? t("unmute") : t("mute");
  return (
    <nav
      aria-label={t("controls")}
      className={cn("mx-auto flex w-fit items-center gap-2.5 rounded-full p-2", GLASS)}
    >
      <button
        type="button"
        aria-label={mute}
        title={mute}
        aria-pressed={muted}
        disabled={!canMute}
        onClick={onMute}
        className={cn(
          "flex size-12 items-center justify-center rounded-full transition-[background-color,transform] duration-200 active:scale-90 disabled:opacity-35",
          muted
            ? "bg-studio-foreground text-studio"
            : "bg-studio-foreground/10 hover:bg-studio-foreground/20",
        )}
      >
        {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
      </button>
      {shutter}
      <button
        ref={endRef}
        type="button"
        aria-label={t("end")}
        title={t("end")}
        onClick={onEnd}
        className="flex size-12 items-center justify-center rounded-full bg-record text-record-foreground transition-transform duration-200 active:scale-90"
      >
        <PhoneOff className="size-5" aria-hidden />
      </button>
    </nav>
  );
}
