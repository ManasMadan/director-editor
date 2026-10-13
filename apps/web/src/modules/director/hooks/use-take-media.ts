"use client";

import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import { useEffect, useRef, useState } from "react";
import type { Clip } from "../lib/edit";
import { type Frame, soundPeaks, videoFrames } from "../lib/thumbnails";
import { PX_PER_SECOND } from "../lib/track";

/** A filmed clip's take, in memory: to play, to show on the timeline and to stitch. */
export interface TakeMedia {
  blob: Blob;
  url: string;
  /** Frames along the kept part, each at its time in the take (a photo: itself). */
  thumbnails: Frame[];
  /** The waveform's bars, or null for a take with no sound. */
  peaks: number[] | null;
}

export type MediaState = TakeMedia | "loading" | "failed";

/** A thumbnail is 36 CSS pixels wide on a 64-pixel strip; a waveform bar is 4. */
const THUMB_PX = 36;
const BAR_PX = 4;

/** A take's bytes, through a short-lived storage URL (a failed read is no take at all). */
async function takeBytes(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`storage answered ${response.status}`);
  }
  return response.blob();
}

async function load(clip: Clip, blob: Blob, url: string): Promise<TakeMedia> {
  const width = clip.seconds * PX_PER_SECOND;
  if (clip.shot.kind === "photo") {
    return { blob, url, thumbnails: [{ seconds: 0, src: url }], peaks: null };
  }
  const count = Math.max(1, Math.ceil(width / THUMB_PX));
  const step = (clip.to - clip.from) / count;
  const times = Array.from({ length: count }, (_, at) => clip.from + step * (at + 0.5));
  const [thumbnails, peaks] = await Promise.all([
    videoFrames(url, times),
    soundPeaks(blob, clip.from, clip.to, Math.max(1, Math.round(width / BAR_PX))),
  ]);
  return { blob, url, thumbnails, peaks };
}

/** What makes a clip's media stale: another take, or another part of it kept. */
const keyOf = (clip: Clip) => `${clip.take?.id}:${clip.from}:${clip.to}`;

/**
 * Each filmed clip's take, downloaded once and kept as a blob: URL for the page's life,
 * with its timeline thumbnails and waveform. Keyed by clip index.
 */
export function useTakeMedia(clips: readonly Clip[]): Map<number, MediaState> {
  const downloadUrl = useFileDownloadUrl();
  const [media, setMedia] = useState(new Map<number, MediaState>());
  const started = useRef(new Map<number, string>());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    for (const clip of clips) {
      const take = clip.take;
      if (clip.state !== "cut" || !take || started.current.get(clip.index) === keyOf(clip)) {
        continue;
      }
      const key = keyOf(clip);
      started.current.set(clip.index, key);
      const set = (state: MediaState) =>
        setMedia((now) =>
          started.current.get(clip.index) === key ? new Map(now).set(clip.index, state) : now,
        );
      set("loading");
      downloadUrl(take.fileId)
        .then(({ url }) => takeBytes(url))
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          urls.current.push(url);
          return load(clip, blob, url);
        })
        .then(set, () => set("failed"));
    }
  }, [clips, downloadUrl]);

  useEffect(() => {
    const made = urls.current;
    return () => {
      for (const url of made) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  return media;
}
