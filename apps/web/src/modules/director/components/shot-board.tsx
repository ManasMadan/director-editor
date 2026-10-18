"use client";

import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Camera, ChevronLeft, ChevronRight, Clapperboard, SparkleIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef } from "react";
import type { shotPage } from "../hooks/use-studio";
import type { MediaState } from "../hooks/use-take-media";
import type { Clip } from "../lib/edit";
import { type Picks, stepPick, takeNumber, takesInOrder } from "../lib/picks";
import { columnWidth } from "../lib/track";

/** A shot's camera screen, to film it (again). */
type ShotPage = ReturnType<typeof shotPage>;

interface ColumnProps {
  clip: Clip;
  shot: DirectorShot;
  media: Map<DirectorTakeId, MediaState>;
  picks: Picks;
  /** How far the clock is through this shot, from 0 to 1. */
  progress: number;
  retakeHref: ShotPage;
  onPick: (shotIndex: number, takeId: DirectorTakeId) => void;
  onSeek: (clip: Clip) => void;
}

/** Director's four-point sparkle in the aurora's colours: Gemini picked this one. */
function PickSparkle({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className}>
      <defs>
        <linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--aurora-1)" />
          <stop offset="50%" stopColor="var(--aurora-2)" />
          <stop offset="100%" stopColor="var(--aurora-3)" />
        </linearGradient>
      </defs>
      <SparkleIcon fill={`url(#${gradient})`} stroke="none" />
    </svg>
  );
}

/** The shot's number, title and length, over a bar that fills as the clock plays it. */
function ShotHeader({ clip, progress, onSeek }: Pick<ColumnProps, "clip" | "progress" | "onSeek">) {
  const t = useTranslations("director.editor");
  return (
    <button
      type="button"
      onClick={() => onSeek(clip)}
      aria-label={t("playFrom", { index: clip.index + 1, title: clip.shot.title })}
      className="sticky top-0 z-10 flex flex-col gap-1.5 bg-studio pt-1 pb-2 text-left"
    >
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-studio-foreground/50 tabular-nums">
          {clip.index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{clip.shot.title}</span>
        <span className="font-mono text-xs text-studio-foreground/50 tabular-nums">
          {t("seconds", { seconds: clip.seconds })}
        </span>
      </span>
      <span aria-hidden className="h-1 overflow-hidden rounded-full bg-studio-foreground/15">
        <span
          className="block h-full origin-left rounded-full bg-studio-foreground"
          style={{ transform: `scaleX(${progress})` }}
        />
      </span>
    </button>
  );
}

/** Director's note on a shot whose best take scored too low: what to fix, and a retake. */
function RetakeNote({ feedback, href }: { feedback: string | null; href: ShotPage }) {
  const t = useTranslations("director");
  return (
    <div className="-rotate-1 rounded-xl bg-doodle-pop p-2.5 text-studio shadow-lg">
      <p className="text-xs font-bold">{t("editor.needsRetake")}</p>
      {feedback ? (
        <p className="mt-0.5 font-[family-name:var(--font-hand)] text-base leading-snug">
          {feedback}
        </p>
      ) : null}
      <Link
        href={href}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-studio px-3 py-1.5 text-xs font-semibold text-studio-foreground"
      >
        <Clapperboard className="size-3.5" aria-hidden />
        {t("review.retake")}
      </Link>
    </div>
  );
}

/** What a take's card says about its review: the score, or that it's still being watched. */
function ReviewLine({ take }: { take: DirectorTake }) {
  const t = useTranslations("director.review");
  if (take.status === "pending" || take.status === "reviewing") {
    return (
      <span className="flex flex-col gap-1">
        <span className="text-xs text-studio-foreground/70">{t("reviewing")}</span>
        <GeminiShimmer className="h-1.5 w-full bg-studio-foreground/10" />
      </span>
    );
  }
  return take.score === null ? null : (
    <span className="text-xs font-semibold tabular-nums">{t("score", { score: take.score })}</span>
  );
}

function TakeCard({
  shot,
  take,
  checked,
  state,
  showFeedback,
  onPick,
}: {
  shot: DirectorShot;
  take: DirectorTake;
  checked: boolean;
  state: MediaState | undefined;
  showFeedback: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("director.editor");
  const picked = take.id === shot.pickedTakeId;
  return (
    <label
      className={cn(
        "relative flex shrink-0 snap-start cursor-pointer gap-2 rounded-xl p-1.5 transition-colors",
        "has-focus-visible:outline-2 has-focus-visible:outline-studio-foreground",
        checked
          ? "bg-studio-foreground/15 ring-2 ring-studio-foreground"
          : "bg-studio-foreground/5 opacity-70 hover:opacity-100",
        picked && !checked && "ring-1 ring-[color-mix(in_oklch,var(--aurora-2)_70%,transparent)]",
      )}
    >
      <input
        type="radio"
        name={`shot-${shot.index}`}
        checked={checked}
        onChange={onPick}
        className="sr-only"
      />
      <span className="relative flex aspect-9/16 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-studio-foreground/10">
        {typeof state === "object" ? (
          // A blob: or data: URL, which Next's image component can't load.
          <img src={state.poster} alt="" className="size-full object-cover" />
        ) : (
          <Camera className="size-4 text-studio-foreground/40" aria-hidden />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold">
          {t("take", { number: takeNumber(shot, take.id) })}
        </span>
        <ReviewLine take={take} />
        {picked ? (
          <span className="flex items-center gap-1 text-xs font-medium">
            <PickSparkle className="size-3.5 shrink-0" />
            {t("directorsPick")}
          </span>
        ) : null}
        {showFeedback && take.feedback ? (
          <span className="font-[family-name:var(--font-hand)] text-sm leading-snug text-studio-foreground/85">
            {take.feedback}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** ‹ take 2 of 5 ›: steps the pick through the takes in the order they were filmed. */
function Stepper({
  shot,
  picks,
  current,
  onPick,
}: Pick<ColumnProps, "shot" | "picks" | "onPick"> & { current: DirectorTakeId }) {
  const t = useTranslations("director.editor");
  const button = (takeId: DirectorTakeId | null, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={takeId ? () => onPick(shot.index, takeId) : undefined}
      disabled={!takeId}
      aria-label={label}
      className="flex size-9 items-center justify-center rounded-full bg-studio-foreground/10 disabled:opacity-30"
    >
      {icon}
    </button>
  );
  return (
    <div className="flex items-center justify-between gap-1">
      {button(
        stepPick(shot, picks, -1),
        t("previousTake"),
        <ChevronLeft className="size-5" aria-hidden />,
      )}
      <span className="text-xs font-medium tabular-nums" aria-live="polite">
        {t("takeOf", { number: takeNumber(shot, current), count: shot.takes.length })}
      </span>
      {button(
        stepPick(shot, picks, 1),
        t("nextTake"),
        <ChevronRight className="size-5" aria-hidden />,
      )}
    </div>
  );
}

function NotFilmed({ href }: { href: ShotPage }) {
  const t = useTranslations("director.review");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-studio-foreground/25 p-3 text-center">
      <p className="text-xs text-studio-foreground/70">{t("missing")}</p>
      <Link
        href={href}
        className="rounded-full bg-record px-3 py-1.5 text-xs font-semibold text-record-foreground"
      >
        {t("film")}
      </Link>
    </div>
  );
}

function ShotColumn({
  column,
  ...props
}: ColumnProps & { column: (element: HTMLFieldSetElement | null) => void }) {
  const t = useTranslations("director");
  const { clip, shot, media, picks, retakeHref, onPick } = props;
  const playing = clip.take?.id;
  const directorsPick = shot.takes.find((take) => take.id === shot.pickedTakeId);
  return (
    // A fieldset: the shot's takes are a choice, and the column names what it's for.
    <fieldset
      ref={column}
      aria-label={t("editor.clip", { index: clip.index + 1, title: clip.shot.title })}
      className="flex h-full min-w-0 shrink-0 snap-start flex-col gap-2 overflow-y-auto overscroll-y-contain px-1 [scrollbar-width:none]"
      style={{ width: columnWidth(clip.seconds) }}
    >
      <ShotHeader clip={clip} progress={props.progress} onSeek={props.onSeek} />
      {/* In reach at the top, however many takes the column scrolls through. */}
      {playing && shot.takes.length > 1 ? (
        <Stepper shot={shot} picks={picks} current={playing} onPick={onPick} />
      ) : null}
      {shot.needsRetake ? (
        <RetakeNote feedback={directorsPick?.feedback ?? null} href={retakeHref} />
      ) : null}
      {shot.takes.length === 0 ? (
        <NotFilmed href={retakeHref} />
      ) : (
        <div
          role="radiogroup"
          aria-label={t("editor.takesOf", { index: clip.index + 1 })}
          className="flex snap-y snap-mandatory flex-col gap-1.5"
        >
          {takesInOrder(shot).map((take) => (
            <TakeCard
              key={take.id}
              shot={shot}
              take={take}
              checked={take.id === playing}
              state={media.get(take.id)}
              // The note above already says what Director thought of its pick.
              showFeedback={take.id === playing && !(shot.needsRetake && take === directorsPick)}
              onPick={() => onPick(shot.index, take.id)}
            />
          ))}
        </div>
      )}
      {shot.takes.length > 0 && !shot.needsRetake ? (
        <Link
          href={retakeHref}
          className="mt-auto self-start rounded-full px-1 py-1 text-xs font-semibold text-studio-foreground/70 underline-offset-4 hover:underline"
        >
          {t("review.retake")}
        </Link>
      ) : null}
    </fieldset>
  );
}

/**
 * The edit as a board of shots, left to right in the order they play, each column as wide
 * as its shot is long: its takes stacked top to bottom (the one playing outlined, Director's
 * pick with its sparkle), a stepper to change the pick, and a retake. On a phone each shot
 * snaps into place as the board is swiped, and a column scrolls on its own for more takes.
 */
export function ShotBoard({
  clips,
  shots,
  media,
  picks,
  time,
  playing,
  shotHref,
  onPick,
  onSeek,
}: {
  clips: readonly Clip[];
  shots: readonly DirectorShot[];
  media: Map<DirectorTakeId, MediaState>;
  picks: Picks;
  time: number;
  playing: boolean;
  shotHref: (index: number) => ShotPage;
  onPick: (shotIndex: number, takeId: DirectorTakeId) => void;
  onSeek: (clip: Clip) => void;
}) {
  const t = useTranslations("director.editor");
  const columns = useRef(new Map<number, HTMLFieldSetElement>());
  const active = clips.find((clip) => time < clip.at + clip.seconds)?.index ?? clips.length - 1;

  // While it plays, the shot playing comes into view (not while the member looks around).
  useEffect(() => {
    if (playing) {
      columns.current
        .get(active)
        ?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    }
  }, [active, playing]);

  return (
    <section
      aria-label={t("board")}
      className="flex min-h-0 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] [scrollbar-width:none]"
    >
      {clips.map((clip) => (
        <ShotColumn
          key={clip.index}
          column={(element) => {
            if (element) {
              columns.current.set(clip.index, element);
            } else {
              columns.current.delete(clip.index);
            }
          }}
          clip={clip}
          shot={required(shots[clip.index], "the shot's takes")}
          media={media}
          picks={picks}
          progress={Math.min(1, Math.max(0, (time - clip.at) / clip.seconds))}
          retakeHref={shotHref(clip.index)}
          onPick={onPick}
          onSeek={onSeek}
        />
      ))}
    </section>
  );
}
