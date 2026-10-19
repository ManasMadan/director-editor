"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { RotateCcw, SwitchCamera, X } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { timecode } from "../lib/track";
import type { ChangedRow } from "../lib/your-version";

const NO_CHANGES: ReadonlySet<ChangedRow> = new Set<ChangedRow>();

/** Frosted glass on the dark stage: the shoot screen's one material. */
export const GLASS =
  "bg-studio/72 backdrop-blur-xl backdrop-saturate-150 ring-1 ring-studio-foreground/12";

/**
 * Story-style segments for the shots: done, this one, still to come. On the glass, so
 * they keep their contrast over a bright camera picture.
 */
export function ShotProgress({ index, count }: { index: number; count: number }) {
  const t = useTranslations("director.shoot");
  return (
    <div
      role="img"
      aria-label={t("shotOf", { index: index + 1, count })}
      className={cn("flex w-24 gap-1 rounded-full px-2.5 py-2", GLASS)}
    >
      {Array.from({ length: count }, (_, at) => (
        <span
          key={`shot-${at + 1}`}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-300",
            at < index && "bg-studio-foreground",
            at === index && "bg-doodle-pop",
            at > index && "bg-studio-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

/** "● REC 00:03": always in view while a take records, and read out once as it starts. */
export function RecordingPill({ seconds }: { seconds: number }) {
  const t = useTranslations("director.shoot");
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-full bg-record px-3 py-1 text-sm font-semibold text-record-foreground tabular-nums shadow-lg"
    >
      <span
        aria-hidden
        className="live-motion size-2 animate-[live-breathe_1.2s_ease-in-out_infinite] rounded-full bg-record-foreground"
      />
      <span>{t("rec")}</span>
      <span aria-hidden>{timecode(seconds)}</span>
    </p>
  );
}

/**
 * Back to the short's page; the camera and Director go with the screen. `onClick` can
 * stop it, to ask first while a take isn't kept.
 */
export function LeaveLink({
  videoId,
  href,
  onClick,
}: {
  videoId: string;
  /** Where ✕ leads, when not the short's page (a retake goes back to the editor). */
  href?: Route;
  onClick?: (event: { preventDefault: () => void }) => void;
}) {
  const t = useTranslations("director.shoot");
  return (
    <Link
      href={href ?? `/director/${videoId}`}
      onClick={onClick}
      aria-label={t("leave")}
      title={t("leave")}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90",
        GLASS,
      )}
    >
      <X className="size-5" aria-hidden />
    </Link>
  );
}

/** A changed row's text, "changed for you", and ↺ to put the original back. */
function ChangedText({
  text,
  label,
  whole,
  onRestore,
}: {
  text: string;
  label: string;
  whole: boolean;
  onRestore: (() => void) | undefined;
}) {
  const t = useTranslations("director.shoot.card");
  return (
    // Keyed on the text by the card, so a further change glows again.
    <dd className="-mx-1 animate-[live-changed_1.6s_ease-out_both] rounded-md px-1">
      <span className={cn(!whole && "line-clamp-2")}>{text}</span>
      <span className="flex items-center gap-1 text-xs text-guide">
        {t("changed")}
        {onRestore ? (
          <button
            type="button"
            onClick={onRestore}
            aria-label={t("restore", { row: label })}
            title={t("restore", { row: label })}
            className="-my-3 flex size-11 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </span>
    </dd>
  );
}

/**
 * What to do in this shot, as the member has it: where, what, the line to say and, once
 * Director changed it, the framing. A row Director changed for them glows once, says so,
 * and has ↺ to put the original back (`onRestore`). The line is shown whole: it's what the
 * member has to say, and the teleprompter only shows it once the take records.
 */
export function ShotCard({
  shot,
  index,
  changed = NO_CHANGES,
  onRestore,
}: {
  shot: Shot;
  index: number;
  changed?: ReadonlySet<ChangedRow>;
  onRestore?: (row: ChangedRow) => void;
}) {
  const t = useTranslations("director.shoot.card");
  const what = shot.steps[0]?.instruction ?? shot.pose.description;
  const line = shot.script.map((said) => said.text).join(" ");
  const rows: { id: ChangedRow; text: string }[] = [
    { id: "where", text: shot.scene },
    { id: "do", text: what },
    ...(line ? [{ id: "say" as const, text: t("line", { line }) }] : []),
    ...(changed.has("framing") ? [{ id: "framing" as const, text: shot.framing.note }] : []),
  ];
  return (
    <section
      aria-label={t("label", { index: index + 1 })}
      className={cn("live-motion rounded-2xl px-3.5 py-2.5 text-sm", GLASS)}
    >
      <h2 className="truncate text-[0.9375rem] font-semibold">
        {t("title", { index: index + 1, title: shot.title })}
      </h2>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-studio-foreground/65">{t(row.id)}</dt>
            {changed.has(row.id) ? (
              <ChangedText
                key={row.text}
                text={row.text}
                label={t(row.id)}
                whole={row.id === "say"}
                onRestore={onRestore ? () => onRestore(row.id) : undefined}
              />
            ) : (
              <dd className={cn(row.id !== "say" && "line-clamp-2")}>{row.text}</dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

const RING = 2 * Math.PI * 36;

export type ShutterMode = "record" | "photo" | "stop" | "cancel";

function ShutterFace({ mode }: { mode: ShutterMode }) {
  if (mode === "cancel") {
    return (
      <span className="flex size-[60px] items-center justify-center rounded-full bg-studio/70">
        <X className="size-7" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "transition-all duration-300 ease-out",
        // Radii in pixels, not rounded-full: a 9999px radius would stay round through the
        // whole morph, and the stop only turned square in its last frame.
        mode === "stop" ? "size-7 rounded-[5px] bg-record" : "size-[60px] rounded-[30px]",
        mode === "record" && "bg-record group-hover:scale-95",
        mode === "photo" && "bg-studio-foreground group-hover:scale-95",
      )}
    />
  );
}

/**
 * The shutter, the only thing that starts a take: a white ring round a red dot to record
 * (a white one for a photo), a cross to call off the countdown, a red square to stop,
 * with the take's progress running round the ring while it records.
 */
export function Shutter({
  mode,
  label,
  progress,
  disabled,
  onClick,
}: {
  mode: ShutterMode;
  label: string;
  progress: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="group relative flex size-[76px] shrink-0 items-center justify-center rounded-full transition-transform duration-200 active:scale-90 disabled:opacity-40"
    >
      <svg aria-hidden viewBox="0 0 80 80" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          strokeWidth="4"
          className="stroke-studio-foreground/85"
        />
        {mode === "stop" ? (
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - Math.min(1, progress))}
            className="stroke-doodle-pop transition-[stroke-dashoffset] duration-100 ease-linear"
          />
        ) : null}
      </svg>
      <ShutterFace mode={mode} />
    </button>
  );
}

/** Flips between the selfie camera and the back one. */
export function FlipButton({ onFlip, disabled }: { onFlip: () => void; disabled: boolean }) {
  const t = useTranslations("director.shoot");
  return (
    <button
      type="button"
      aria-label={t("flip")}
      title={t("flip")}
      onClick={onFlip}
      disabled={disabled}
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90 disabled:opacity-40",
        GLASS,
      )}
    >
      <SwitchCamera className="size-5" aria-hidden />
    </button>
  );
}

/** "3, 2, 1": each number lands big in the middle, read out as it changes. */
export function CountdownNumber({ seconds }: { seconds: number | null }) {
  const t = useTranslations("director.shoot");
  if (seconds === null) {
    return null;
  }
  return (
    <div
      aria-live="assertive"
      className="live-motion pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span
        key={seconds}
        className="animate-[live-count_500ms_ease-out_forwards] text-[9rem] leading-none font-black text-studio-foreground drop-shadow-[0_6px_24px_rgb(0_0_0/0.6)]"
      >
        {t("countdown", { seconds })}
      </span>
    </div>
  );
}
