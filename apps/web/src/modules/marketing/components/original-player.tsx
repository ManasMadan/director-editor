"use client";

import { Play } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { YouTubeEmbed } from "@/modules/shorts";

/**
 * A Short's original, as a still until someone presses play: YouTube's player brings
 * about a megabyte of script, which the landing loads only for a visitor who wants it.
 * Labels come translated from the server page.
 */
export function OriginalPlayer({
  videoId,
  thumbnail,
  playLabel,
  playerTitle,
}: {
  videoId: string;
  thumbnail: string;
  playLabel: string;
  playerTitle: string;
}) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="relative aspect-9/16 w-full overflow-hidden rounded-3xl bg-studio">
      {playing ? (
        <YouTubeEmbed
          videoId={videoId}
          title={playerTitle}
          options={{ autoplay: true, controls: true }}
          className="absolute inset-0 size-full"
        />
      ) : (
        <button
          type="button"
          aria-label={playLabel}
          onClick={() => setPlaying(true)}
          className="group absolute inset-0 grid place-items-center outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          <Image src={thumbnail} alt="" fill unoptimized sizes="20rem" className="object-cover" />
          <span className="relative grid size-16 place-items-center rounded-full bg-record text-record-foreground shadow-lg transition-transform group-hover:scale-105">
            <Play aria-hidden className="size-7 translate-x-0.5 fill-current" />
          </span>
        </button>
      )}
    </div>
  );
}
