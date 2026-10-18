"use client";

import { cn } from "@repo/ui/lib/utils";
import { Pause, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import type { ShotState } from "../lib/roll";
import { timecode } from "../lib/track";
import { GLASS } from "./shoot-parts";

/**
 * The roll's indicator, top left and always there: a red dot and the time recorded
 * ("● REC 03:12"), and next to it pause (or Resume, while paused).
 */
export function RecIndicator({
  elapsedMs,
  paused,
  onPause,
  onResume,
}: {
  elapsedMs: number;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
}) {
  const t = useTranslations("director.shoot");
  const time = timecode(elapsedMs / 1000);
  return (
    <div className="flex items-center gap-1.5">
      <p
        role="status"
        aria-label={paused ? t("roll.paused") : t("roll.recording", { time })}
        className={cn(
          "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold tabular-nums shadow-lg",
          paused ? GLASS : "bg-record text-record-foreground",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "live-motion size-2 rounded-full",
            paused
              ? "bg-studio-foreground/60"
              : "animate-[live-breathe_1.2s_ease-in-out_infinite] bg-record-foreground",
          )}
        />
        <span aria-hidden>{paused ? t("roll.paused") : t("rec")}</span>
        <span aria-hidden>{time}</span>
      </p>
      <button
        type="button"
        onClick={paused ? onResume : onPause}
        aria-label={paused ? t("roll.resume") : t("roll.pause")}
        title={paused ? t("roll.resume") : t("roll.pause")}
        className={cn(
          "flex size-9 items-center justify-center rounded-full transition-transform active:scale-90",
          GLASS,
        )}
      >
        {paused ? (
          <Play className="size-4" aria-hidden />
        ) : (
          <Pause className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}

/**
 * Paused: the picture greys out, and only a touch (Resume, or Space) starts recording
 * again. Nothing said restarts it.
 */
export function PausedVeil({ onResume }: { onResume: () => void }) {
  const t = useTranslations("director.shoot.roll");
  useEffect(() => {
    const space = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        onResume();
      }
    };
    window.addEventListener("keydown", space);
    return () => window.removeEventListener("keydown", space);
  }, [onResume]);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-studio/60 p-8 text-center backdrop-grayscale">
      <p className="max-w-xs text-[15px] font-semibold">{t("pausedBody")}</p>
      <button
        type="button"
        onClick={onResume}
        className="flex min-h-14 items-center gap-2 rounded-full bg-studio-foreground px-8 text-lg font-semibold text-studio shadow-xl transition-transform active:scale-95"
      >
        <Play className="size-5" aria-hidden />
        {t("resume")}
      </button>
    </div>
  );
}

/** Done, where the shutter was: the roll stops and the footage goes to the editor. */
export function DoneButton({ onDone, disabled }: { onDone: () => void; disabled: boolean }) {
  const t = useTranslations("director.shoot.roll");
  return (
    <button
      type="button"
      onClick={onDone}
      disabled={disabled}
      className="min-h-14 min-w-28 rounded-full bg-studio-foreground px-8 text-lg font-semibold text-studio shadow-xl transition-transform active:scale-95 disabled:opacity-50"
    >
      {t("done")}
    </button>
  );
}

const MARKS: Record<ShotState, string> = { take: "✓", tried: "•", todo: "○" };

/**
 * The progress strip: a mark per shot (✓ a take, • tried, ○ to do), the one on screen
 * lit. Tapping one goes there, and Director with it.
 */
export function RollProgress({
  index,
  states,
  onGo,
}: {
  index: number;
  states: readonly ShotState[];
  onGo: (shot: number) => void;
}) {
  const t = useTranslations("director.shoot.roll");
  return (
    <nav
      aria-label={t("progress")}
      className={cn("flex gap-0.5 rounded-full px-1.5 py-0.5", GLASS)}
    >
      {states.map((state, shot) => (
        <button
          key={`shot-${shot + 1}`}
          type="button"
          onClick={() => onGo(shot)}
          aria-label={t("shot", { index: shot + 1, state })}
          aria-current={shot === index ? "step" : undefined}
          className={cn(
            "flex size-7 items-center justify-center rounded-full text-sm font-semibold",
            shot === index ? "bg-studio-foreground text-studio" : "text-studio-foreground/80",
          )}
        >
          <span aria-hidden>{MARKS[state]}</span>
        </button>
      ))}
    </nav>
  );
}

/** After Done: the footage still on this device uploads before the editor opens. */
export function SavingFootage({ behindMs }: { behindMs: number }) {
  const t = useTranslations("director.shoot.roll");
  const seconds = Math.ceil(behindMs / 1000);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-studio/80 p-8 text-center">
      <p role="status" className="text-lg font-semibold">
        {seconds > 0 ? t("savingBehind", { seconds }) : t("saving")}
      </p>
    </div>
  );
}
