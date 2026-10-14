"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { MapPin, ScanFace, Smartphone, Sun, Timer, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Countdown } from "../lib/memory";
import { CHECKS, type Check, isReady, type Readiness } from "../lib/readiness";
import { timecode } from "../lib/track";

/** Frosted glass on the dark stage: the HUD's one material. */
export const GLASS =
  "bg-studio/45 backdrop-blur-xl backdrop-saturate-150 ring-1 ring-studio-foreground/12";

/** Four bars that dance while someone's talking, and rest as a dot when no one is. */
function VoiceBars({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn(
            "w-[3px] origin-center rounded-full bg-current transition-[height]",
            active ? "h-full animate-[live-bar_900ms_ease-in-out_infinite]" : "h-[3px]",
          )}
          style={{ animationDelay: `${bar * 120}ms` }}
        />
      ))}
    </span>
  );
}

export type LiveMode = "live" | "paused" | "recording";

/** "Live", breathing; "Paused"; or the take's running time while recording. */
export function LivePill({
  mode,
  talking,
  seconds,
  onDevice,
}: {
  mode: LiveMode;
  talking: boolean;
  seconds: number;
  onDevice: boolean;
}) {
  const t = useTranslations("director.live");
  if (mode === "recording") {
    return (
      <p className="flex items-center gap-2 rounded-full bg-record px-3.5 py-1.5 text-sm font-semibold text-record-foreground tabular-nums shadow-lg">
        <span className="size-2 animate-[live-breathe_1.2s_ease-in-out_infinite] rounded-full bg-record-foreground" />
        {timecode(seconds)}
      </p>
    );
  }
  return (
    <p
      className={cn(
        "flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold",
        GLASS,
      )}
    >
      {mode === "paused" ? (
        <span className="size-2 rounded-full bg-studio-foreground/50" />
      ) : (
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-[live-breathe_2.8s_ease-in-out_infinite] rounded-full bg-aurora-1" />
        </span>
      )}
      <span>{mode === "paused" ? t("paused") : t("live")}</span>
      {mode === "live" ? <VoiceBars active={talking} /> : null}
      {onDevice ? (
        <span
          title={t("onDeviceHint")}
          className="rounded-full bg-studio-foreground/15 px-2 py-0.5 text-[11px]"
        >
          {t("onDevice")}
        </span>
      ) : null}
    </p>
  );
}

/** Story-style segments for the shots: done, this one, still to come. */
export function ShotDots({ index, count }: { index: number; count: number }) {
  const t = useTranslations("director.shoot");
  return (
    <div
      role="img"
      aria-label={t("shotOf", { index: index + 1, count })}
      className="flex w-16 gap-1"
    >
      {Array.from({ length: count }, (_, at) => (
        <span
          key={`shot-${at + 1}`}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors",
            at < index && "bg-studio-foreground",
            at === index && "bg-doodle-pop",
            at > index && "bg-studio-foreground/25",
          )}
        />
      ))}
    </div>
  );
}

const TIMER_STEPS: (Countdown | null)[] = [null, 3, 5, 10];

/** The countdown: Auto (Director's choice, learned) or a fixed 3, 5 or 10 seconds. */
export function TimerButton({
  chosen,
  seconds,
  onChoose,
}: {
  chosen: Countdown | null;
  seconds: Countdown;
  onChoose: (next: Countdown | null) => void;
}) {
  const t = useTranslations("director.live.dock");
  const next = TIMER_STEPS[(TIMER_STEPS.indexOf(chosen) + 1) % TIMER_STEPS.length] ?? null;
  return (
    <button
      type="button"
      onClick={() => onChoose(next)}
      aria-label={t("timer", { seconds })}
      title={chosen === null ? t("timerAutoHint") : undefined}
      className={cn(
        "flex h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold tabular-nums",
        GLASS,
      )}
    >
      <Timer className="size-4" aria-hidden />
      {chosen === null ? t("timerAutoValue", { seconds }) : t("timerValue", { seconds })}
    </button>
  );
}

export function VoiceButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const t = useTranslations("director.live.dock");
  return (
    <button
      type="button"
      aria-label={t("speak")}
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "flex size-9 items-center justify-center rounded-full",
        on ? "bg-studio-foreground text-studio" : GLASS,
      )}
    >
      {on ? (
        <Volume2 className="size-[18px]" aria-hidden />
      ) : (
        <VolumeX className="size-[18px]" aria-hidden />
      )}
    </button>
  );
}

/** "Take 2 • Medium shot": which attempt this is and the shot's size. */
export function StatusPill({ take, size }: { take: number; size: Shot["framing"]["shotSize"] }) {
  const t = useTranslations("director.live");
  return (
    <p className={cn("rounded-full px-3 py-1.5 text-xs font-semibold", GLASS)}>
      {t("status", { take, size: t(`size.${size}`) })}
    </p>
  );
}

const ICONS = { spot: MapPin, frame: ScanFace, angle: Smartphone, light: Sun } as const;

/** The ready check as four lights: green when fine, amber when not, gone when not judged. */
export function ReadyCheck({ readiness }: { readiness: Readiness }) {
  const t = useTranslations("director.live.ready");
  const judged = CHECKS.filter((check) => readiness[check] !== "na");
  if (judged.length === 0) {
    return null;
  }
  const done = judged.filter((check) => readiness[check] === "ok").length;
  const ready = isReady(readiness);
  return (
    <div
      role="img"
      aria-label={t("done", { done, total: judged.length })}
      className={cn(
        "flex items-center gap-1 rounded-full p-1 transition-[background-color,box-shadow] duration-500",
        ready ? "bg-guide/25 ring-1 ring-guide/60" : GLASS,
      )}
    >
      {judged.map((check) => {
        const Icon = ICONS[check];
        const state: Check = readiness[check];
        return (
          <span
            key={check}
            title={t(check)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full transition-colors duration-300",
              state === "ok" ? "bg-guide text-studio" : "text-guide-warn",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        );
      })}
    </div>
  );
}
