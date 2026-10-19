"use client";

import { useApiErrorMessage } from "@repo/client";
import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Camera, ChevronLeft, ChevronRight, Clapperboard } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { shotPage } from "../hooks/use-studio";
import type { MediaState } from "../hooks/use-take-media";
import type { Clip } from "../lib/edit";
import { type Picks, picksFirst, stepPick, takeNumber } from "../lib/picks";
import { columnWidth } from "../lib/track";
import { PickBadges } from "./directors-picks";

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
  /** Just changed by a request to Director: outlined for a moment. */
  highlighted: boolean;
}

/** The shot's number, title and length, over a bar that fills as the clock plays it. */
function ShotHeader({ clip, progress, onSeek }: Pick<ColumnProps, "clip" | "progress" | "onSeek">) {
  const t = useTranslations("director.editor");
  return (
    <button
      type="button"
      onClick={() => onSeek(clip)}
      aria-label={t("playFrom", { index: clip.index + 1, title: clip.shot.title })}
      className="group/header sticky top-0 z-10 flex min-h-11 cursor-pointer flex-col justify-end gap-1.5 bg-studio pt-1 pb-2 text-left"
    >
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-studio-foreground/50 tabular-nums">
          {clip.index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold underline-offset-4 group-hover/header:underline">
          {clip.shot.title}
        </span>
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

/**
 * Director's note on a shot whose best take scored too low: what to fix, and a retake. The
 * note is the playing take's, so it changes with the member's pick and never describes a
 * take they aren't watching.
 */
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
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-studio px-4 text-sm font-semibold text-studio-foreground"
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
  const errorMessage = useApiErrorMessage();
  if (take.status === "failed") {
    return (
      <span className="text-xs text-studio-error">
        {errorMessage({ code: take.error ?? "DIRECTOR_REVIEW_FAILED" })}
      </span>
    );
  }
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
          : "bg-studio-foreground/5 hover:bg-studio-foreground/10",
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
      {/* Only the picture dims on a take not playing: dimmed words would fail contrast. */}
      <span
        className={cn(
          "relative flex aspect-9/16 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-studio-foreground/10 transition-opacity",
          !checked && "opacity-60",
        )}
      >
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
        <PickBadges shot={shot} take={take} />
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
  // aria-disabled, not disabled: stepping to the first or last take keeps the focus on
  // the button the member just pressed, where a disabled one would drop it to the page.
  const button = (takeId: DirectorTakeId | null, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={takeId ? () => onPick(shot.index, takeId) : undefined}
      aria-disabled={!takeId}
      aria-label={label}
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-studio-foreground/10 transition-colors hover:bg-studio-foreground/20 aria-disabled:cursor-default aria-disabled:opacity-30 aria-disabled:hover:bg-studio-foreground/10"
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
      <span className="text-xs font-medium whitespace-nowrap tabular-nums" aria-live="polite">
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
        className="inline-flex min-h-11 items-center rounded-full bg-record px-4 text-sm font-semibold text-record-foreground transition-colors hover:bg-record/85"
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
  const playingTake = shot.takes.find((take) => take.id === playing);
  return (
    // A fieldset: the shot's takes are a choice, and the column names what it's for.
    <fieldset
      ref={column}
      aria-label={t("editor.clip", { index: clip.index + 1, title: clip.shot.title })}
      className={cn(
        "flex h-full min-w-0 shrink-0 snap-start flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-xl px-1 ring-2 ring-transparent transition-[box-shadow] duration-300 ease-out [scrollbar-width:none]",
        // A long shot never fills a phone's board: the next one always peeks in.
        "max-w-[calc(100vw-4.5rem)]",
        props.highlighted && "ring-record",
      )}
      style={{ width: columnWidth(clip.seconds) }}
    >
      <ShotHeader clip={clip} progress={props.progress} onSeek={props.onSeek} />
      {/* In reach at the top, however many takes the column scrolls through. */}
      {playing && shot.takes.length > 1 ? (
        <Stepper shot={shot} picks={picks} current={playing} onPick={onPick} />
      ) : null}
      {shot.needsRetake ? (
        <RetakeNote feedback={playingTake?.feedback ?? null} href={retakeHref} />
      ) : null}
      {shot.takes.length === 0 ? (
        <NotFilmed href={retakeHref} />
      ) : (
        <div
          role="radiogroup"
          aria-label={t("editor.takesOf", { index: clip.index + 1 })}
          className="flex snap-y snap-mandatory flex-col gap-1.5"
        >
          {picksFirst(shot).map((take) => (
            <TakeCard
              key={take.id}
              shot={shot}
              take={take}
              checked={take.id === playing}
              state={media.get(take.id)}
              // The note above already says what Director thought of the take playing.
              showFeedback={take.id === playing && !shot.needsRetake}
              onPick={() => onPick(shot.index, take.id)}
            />
          ))}
        </div>
      )}
      {/* Right under the takes: pinned to the column's foot, it floated loose on a tall board. */}
      {shot.takes.length > 0 && !shot.needsRetake ? (
        <Link
          href={retakeHref}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-full px-2 text-sm font-semibold text-studio-foreground/80 underline-offset-4 hover:bg-studio-foreground/10 hover:text-studio-foreground"
        >
          <Clapperboard className="size-4" aria-hidden />
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
  locked = false,
  highlight = null,
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
  /** While the video is being made: nothing on the board takes a tap. */
  locked?: boolean;
  /** The shot a request to Director just changed, outlined and brought into view. */
  highlight?: number | null;
}) {
  const t = useTranslations("director.editor");
  const columns = useRef(new Map<number, HTMLFieldSetElement>());
  // What the last swap was, for screen readers: "Swapped in take 3 for shot 1".
  const [swapped, setSwapped] = useState("");
  const pick = (shotIndex: number, takeId: DirectorTakeId) => {
    const shot = required(shots[shotIndex], "the shot picked");
    setSwapped(t("swapped", { number: takeNumber(shot, takeId), index: shotIndex + 1 }));
    onPick(shotIndex, takeId);
  };
  const active = (clips.find((clip) => time < clip.at + clip.seconds) ?? clips.at(-1))?.index;

  // While it plays, the shot playing comes into view (not while the member looks around).
  useEffect(() => {
    if (playing && active !== undefined) {
      columns.current
        .get(active)
        ?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    }
  }, [active, playing]);
  useEffect(() => {
    if (highlight !== null) {
      columns.current
        .get(highlight)
        ?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    }
  }, [highlight]);

  return (
    <section
      aria-label={t("board")}
      inert={locked}
      // Touch swipes the board, so the bar stays hidden there; with a mouse it's the only
      // sign that shots past the right edge are there to scroll to.
      className="transition-opacity inert:opacity-40 flex min-h-0 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] [scrollbar-width:none] pointer-fine:[scrollbar-width:thin]"
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
          onPick={pick}
          onSeek={onSeek}
          highlighted={highlight === clip.index}
        />
      ))}
      <p className="sr-only" aria-live="polite">
        {swapped}
      </p>
    </section>
  );
}
