"use client";

import type { DirectorTakeId } from "@repo/contracts/ids";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { MediaState, TakeMedia } from "../hooks/use-take-media";
import type { CaptionLine, CaptionStyle } from "../lib/captions";
import { type Clip, clipAt } from "../lib/edit";
import { CaptionLayer } from "./caption-layer";

/** How far a video may drift from the clock before it's put back: more while playing. */
const DRIFT_PLAYING = 0.3;
const DRIFT_PAUSED = 0.04;
/** How much a photo slowly zooms in over its time on screen, as the render does. */
const PHOTO_ZOOM = 0.06;

/** Puts the playing clip's video where the clock says, and plays or pauses it with it. */
function follow(
  video: HTMLVideoElement,
  clip: Clip,
  { time, playing, onStall }: { time: number; playing: boolean; onStall: () => void },
) {
  const expected = clip.from + (time - clip.at);
  if (Math.abs(video.currentTime - expected) > (playing ? DRIFT_PLAYING : DRIFT_PAUSED)) {
    video.currentTime = expected;
  }
  if (!playing) {
    video.pause();
    return;
  }
  if (video.paused) {
    video.play().catch((error: unknown) => {
      // Pausing while it starts aborts the start, which is what pausing means.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        onStall();
      }
    });
  }
}

/** Keeps each clip's video on the clock: only the clip at `time` plays, at its place. */
function useVideoSync(
  videos: Map<number, HTMLVideoElement>,
  clips: readonly Clip[],
  {
    time,
    playing,
    sound,
    onStall,
  }: { time: number; playing: boolean; sound: boolean; onStall: () => void },
) {
  const active = clipAt(clips, time);
  useEffect(() => {
    for (const [index, video] of videos) {
      video.muted = !sound;
      if (active && clips[index] === active) {
        follow(video, active, { time, playing, onStall });
      } else {
        video.pause();
      }
    }
  }, [videos, clips, active, time, playing, sound, onStall]);
  return active;
}

function Placeholder({ clip, state }: { clip: Clip; state: MediaState | undefined }) {
  const t = useTranslations("director");
  if (clip.state === "cut" && state !== "failed") {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <GeminiLoader label={t("editor.loading")} />
      </div>
    );
  }
  const message = {
    missing: t("editor.notFilmed", { index: clip.index + 1 }),
    reviewing: t("review.reviewing"),
    cut: t("editor.loadFailed"),
  }[clip.state];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-xs text-studio-foreground/60">{clip.shot.title}</p>
      <p className="text-sm font-semibold">{message}</p>
    </div>
  );
}

/**
 * The edit, played from the takes in memory: each filmed clip's kept part, photos held
 * with a slow zoom, a stand-in for a shot not filmed yet, and the captions over it all as
 * the render will burn them in.
 */
export function EditPlayer({
  clips,
  media,
  time,
  playing,
  clock,
  lines,
  style,
  sound,
  onStall,
}: {
  clips: readonly Clip[];
  media: Map<DirectorTakeId, MediaState>;
  time: number;
  playing: boolean;
  clock: () => number;
  lines: readonly CaptionLine[];
  style: CaptionStyle;
  sound: boolean;
  onStall: () => void;
}) {
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const active = useVideoSync(videos.current, clips, { time, playing, sound, onStall });
  const loaded = clips.flatMap((clip) => {
    const state = clip.take ? media.get(clip.take.id) : undefined;
    return clip.take && typeof state === "object" ? [{ clip, id: clip.take.id, take: state }] : [];
  });
  const showing = active?.take ? media.get(active.take.id) : undefined;
  return (
    <div className="relative aspect-9/16 h-full max-w-full overflow-hidden rounded-xl bg-studio-foreground/10">
      {loaded.map(({ clip, id, take }) => (
        <ClipMedia
          // Another take picked is another element: the old one stops with its own.
          key={`${clip.index}:${id}`}
          id={id}
          clip={clip}
          take={take}
          active={clip === active}
          time={time}
          register={(element) => {
            if (element) {
              videos.current.set(clip.index, element);
            } else {
              videos.current.delete(clip.index);
            }
          }}
        />
      ))}
      {active && typeof showing !== "object" ? <Placeholder clip={active} state={showing} /> : null}
      <CaptionLayer lines={lines} style={style} clock={clock} />
    </div>
  );
}

function ClipMedia({
  clip,
  id,
  take,
  active,
  time,
  register,
}: {
  clip: Clip;
  id: DirectorTakeId;
  take: TakeMedia;
  active: boolean;
  time: number;
  register: (element: HTMLVideoElement | null) => void;
}) {
  if (clip.shot.kind === "photo") {
    const progress = active ? Math.min(1, (time - clip.at) / clip.seconds) : 0;
    return (
      // A blob: URL, which Next's image component can't load.
      <img
        src={take.url}
        alt={clip.shot.title}
        data-take={id}
        className={cn("absolute inset-0 size-full object-cover", !active && "invisible")}
        style={{ transform: `scale(${1 + PHOTO_ZOOM * progress})` }}
      />
    );
  }
  return (
    <video
      ref={register}
      src={take.url}
      data-take={id}
      muted
      playsInline
      preload="auto"
      aria-hidden
      className={cn("absolute inset-0 size-full object-cover", !active && "invisible")}
    />
  );
}
