"use client";

import { required } from "@repo/contracts/objects";
import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "@repo/ui/lib/utils";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MediaState } from "../hooks/use-take-media";
import type { Clip, EditLine } from "../lib/edit";
import { PX_PER_SECOND, rulerTicks } from "../lib/track";

const px = (seconds: number) => seconds * PX_PER_SECOND;

function Ruler({ total }: { total: number }) {
  const t = useTranslations("director.editor");
  return (
    <div aria-hidden className="relative h-7">
      {rulerTicks(total).map((tick) =>
        tick.label ? (
          <span
            key={tick.seconds}
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5 font-mono text-[11px] text-studio-foreground/60"
            style={{ left: px(tick.seconds) }}
          >
            {t("second", { seconds: tick.seconds })}
            <span className="size-1 rounded-full bg-studio-foreground/40" />
          </span>
        ) : (
          <span
            key={tick.seconds}
            className="absolute top-1.5 h-4 w-1 -translate-x-1/2 rounded-full bg-studio-foreground/20"
            style={{ left: px(tick.seconds) }}
          />
        ),
      )}
    </div>
  );
}

function CaptionTrack({
  lines,
  selected,
  onSelect,
}: {
  lines: readonly EditLine[];
  selected: string | null;
  onSelect: (line: EditLine) => void;
}) {
  return (
    <div className="relative h-9">
      {lines.map((line) => (
        <button
          key={line.key}
          type="button"
          onClick={() => onSelect(line)}
          aria-pressed={selected === line.key}
          className={cn(
            "absolute inset-y-0 truncate rounded-md bg-studio-foreground px-2 text-left text-xs font-semibold text-studio",
            selected === line.key && "ring-2 ring-record ring-offset-1 ring-offset-studio",
          )}
          style={{
            left: px(line.startSeconds),
            width: Math.max(12, px(line.endSeconds - line.startSeconds) - 2),
          }}
        >
          {line.text}
        </button>
      ))}
    </div>
  );
}

/** The clip's sound as bars, one path for all of them. */
function Waveform({ clip, bars }: { clip: Clip; bars: readonly number[] }) {
  const width = px(clip.seconds);
  const step = width / Math.max(1, bars.length);
  const path = bars
    .map((bar, at) => {
      const height = Math.max(0.08, bar) * 100;
      return `M${(at * step).toFixed(1)} ${(100 - height).toFixed(1)}h${(step * 0.5).toFixed(1)}V100h-${(step * 0.5).toFixed(1)}Z`;
    })
    .join("");
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      className="absolute inset-y-1 h-[calc(100%-0.5rem)] fill-record-foreground/45"
      style={{ left: px(clip.at), width }}
    >
      <path d={path} />
    </svg>
  );
}

function SoundTrack({
  clips,
  media,
  label,
  on,
}: {
  clips: readonly Clip[];
  media: Map<number, MediaState>;
  label: string;
  on: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex h-9 items-center overflow-hidden rounded-md",
        on ? "bg-record" : "bg-studio-foreground/10",
      )}
    >
      {on
        ? clips.map((clip) => {
            const state = media.get(clip.index);
            return typeof state === "object" && state.peaks ? (
              <Waveform key={clip.index} clip={clip} bars={state.peaks} />
            ) : null;
          })
        : null}
      <span className="sticky left-0 z-10 truncate px-2 text-xs font-semibold text-record-foreground">
        {label}
      </span>
    </div>
  );
}

function ClipBody({ clip, state }: { clip: Clip; state: MediaState | undefined }) {
  const t = useTranslations("director");
  if (clip.state === "missing") {
    return (
      <span className="flex size-full items-center justify-center gap-1 rounded-lg border-2 border-dashed border-studio-foreground/30 text-xs font-semibold">
        <Plus className="size-4" aria-hidden />
        {t("review.film")}
      </span>
    );
  }
  if (clip.state === "reviewing" || state === "loading" || state === undefined) {
    return (
      <span className="flex size-full items-center justify-center bg-studio-foreground/10">
        <Spinner />
      </span>
    );
  }
  if (state === "failed") {
    return <span className="block size-full bg-studio-error/30" />;
  }
  return (
    <span className="flex size-full">
      {state.thumbnails.map((frame) => (
        // A blob: or data: URL, which Next's image component can't load.
        <img
          key={frame.seconds}
          src={frame.src}
          alt=""
          className="h-full w-9 shrink-0 object-cover"
        />
      ))}
    </span>
  );
}

const ClipTrack = memo(function ClipTrack({
  clips,
  media,
  selected,
  onSelect,
}: {
  clips: readonly Clip[];
  media: Map<number, MediaState>;
  selected: number | null;
  onSelect: (clip: Clip) => void;
}) {
  const t = useTranslations("director.editor");
  return (
    <div className="relative h-16">
      {clips.map((clip) => (
        <button
          key={clip.index}
          type="button"
          onClick={() => onSelect(clip)}
          aria-pressed={selected === clip.index}
          aria-label={t("clip", { index: clip.index + 1, title: clip.shot.title })}
          className={cn(
            "absolute inset-y-0 overflow-hidden rounded-lg bg-studio-foreground/5",
            selected === clip.index && "ring-3 ring-studio-foreground",
          )}
          style={{ left: px(clip.at) + 1, width: px(clip.seconds) - 2 }}
        >
          <ClipBody clip={clip} state={media.get(clip.index)} />
        </button>
      ))}
      {clips.slice(1).map((clip) => (
        <span
          key={clip.index}
          aria-hidden
          className="pointer-events-none absolute top-1/2 z-10 flex h-8 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md bg-studio-foreground"
          style={{ left: px(clip.at) }}
        >
          <span className="h-3.5 w-1 rounded-full bg-studio" />
        </span>
      ))}
    </div>
  );
});

/** Half the scroller's width: the padding that lets time 0 and the end reach the playhead. */
function useHalfWidth(element: React.RefObject<HTMLDivElement | null>) {
  const [half, setHalf] = useState(0);
  useEffect(() => {
    const target = required(element.current, "the timeline's scroller");
    const observer = new ResizeObserver(() => setHalf(target.clientWidth / 2));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return half;
}

/**
 * The edit on a timeline that scrolls under a fixed playhead, as phone editors do: the
 * ruler, the captions, the sound and the clips. Scrolling it scrubs; playing scrolls it.
 */
export function EditTimeline({
  clips,
  lines,
  media,
  total,
  time,
  onScrub,
  selectedClip,
  onSelectClip,
  selectedLine,
  onSelectLine,
  soundLabel,
  soundOn,
}: {
  clips: readonly Clip[];
  lines: readonly EditLine[];
  media: Map<number, MediaState>;
  total: number;
  time: number;
  onScrub: (seconds: number) => void;
  selectedClip: number | null;
  onSelectClip: (clip: Clip) => void;
  selectedLine: string | null;
  onSelectLine: (line: EditLine) => void;
  soundLabel: string;
  soundOn: boolean;
}) {
  const t = useTranslations("director.editor");
  const scroller = useRef<HTMLDivElement>(null);
  const half = useHalfWidth(scroller);
  const shown = useRef(time);

  // Playing (or seeking) moves the timeline; a scroll that lands where the clock already
  // is came from here, and isn't a scrub.
  useLayoutEffect(() => {
    shown.current = time;
    const element = scroller.current;
    // Not before the padding is measured: the timeline is too short to scroll until then.
    if (element && half > 0 && Math.abs(element.scrollLeft - px(time)) > 1) {
      element.scrollLeft = px(time);
    }
  }, [time, half]);

  const onScroll = () => {
    const element = scroller.current;
    if (element && Math.abs(element.scrollLeft - px(shown.current)) > 1) {
      onScrub(element.scrollLeft / PX_PER_SECOND);
    }
  };

  return (
    <section aria-label={t("timeline")} className="relative">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex" style={{ width: px(total) + half * 2 }}>
          <div className="shrink-0" style={{ width: half }} />
          <div className="flex shrink-0 flex-col gap-1.5" style={{ width: px(total) }}>
            <Ruler total={total} />
            <CaptionTrack lines={lines} selected={selectedLine} onSelect={onSelectLine} />
            <SoundTrack clips={clips} media={media} label={soundLabel} on={soundOn} />
            <ClipTrack
              clips={clips}
              media={media}
              selected={selectedClip}
              onSelect={onSelectClip}
            />
          </div>
        </div>
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute top-5 bottom-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-studio-foreground"
      />
    </section>
  );
}
