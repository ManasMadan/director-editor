"use client";

import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { useEffect, useRef, useState } from "react";
import type { Clip } from "../lib/edit";
import { videoFrames } from "../lib/thumbnails";

/** A take in memory: to play, to show on the board and to put into the video. */
export interface TakeMedia {
  blob: Blob;
  url: string;
  /** A frame from the middle of the part kept (a photo: itself), for its card. */
  poster: string;
}

export type MediaState = TakeMedia | "loading" | "failed";

/** A take's bytes, through a short-lived storage URL (a failed read is no take at all). */
async function takeBytes(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`storage answered ${response.status}`);
  }
  return response.blob();
}

async function load(clip: Clip, blob: Blob, url: string): Promise<TakeMedia> {
  if (clip.shot.kind === "photo") {
    return { blob, url, poster: url };
  }
  const [frame] = await videoFrames(url, [(clip.from + clip.to) / 2]);
  return { blob, url, poster: required(frame, "a frame of the take").src };
}

/**
 * Each take a clip plays, downloaded once (the first time it's picked) and kept as a
 * blob: URL for the page's life, with its card's frame: picking it again is instant.
 * Keyed by take id. Takes never picked aren't downloaded: a phone shouldn't fetch every
 * attempt of every shot to show one video.
 */
export function useTakeMedia(clips: readonly Clip[]): Map<DirectorTakeId, MediaState> {
  const downloadUrl = useFileDownloadUrl();
  const [media, setMedia] = useState(new Map<DirectorTakeId, MediaState>());
  const started = useRef(new Set<DirectorTakeId>());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    for (const clip of clips) {
      const take = clip.take;
      // A take still being reviewed waits: its review says which part to keep.
      if (clip.state !== "cut" || !take || started.current.has(take.id)) {
        continue;
      }
      started.current.add(take.id);
      const set = (state: MediaState) => setMedia((now) => new Map(now).set(take.id, state));
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
