"use client";

import type { Shot } from "@repo/contracts/api";
import { useCallback, useMemo, useRef } from "react";
import { useObjectUrl } from "../hooks/use-object-url";
import { webVtt } from "../lib/captions";
import { CaptionLayer } from "./caption-layer";

function VideoTake({
  take,
  label,
  script,
  lang,
}: {
  take: Blob;
  label: string;
  script: Shot["script"];
  lang: string;
}) {
  const url = useObjectUrl(take);
  const video = useRef<HTMLVideoElement>(null);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(script)], { type: "text/vtt" }), [script]),
  );
  const clock = useCallback(() => video.current?.currentTime ?? 0, []);
  return (
    <>
      <video
        ref={video}
        src={url ?? undefined}
        aria-label={label}
        controls
        autoPlay
        loop
        playsInline
        className="absolute inset-0 size-full bg-studio object-cover"
      >
        {/* Shown styled over the picture (below); the track serves screen readers' players. */}
        <track kind="captions" src={captions ?? undefined} srcLang={lang} label={label} />
      </video>
      <CaptionLayer lines={script} style="pop" clock={clock} />
    </>
  );
}

function PhotoTake({ take, label }: { take: Blob; label: string }) {
  const url = useObjectUrl(take);
  if (!url) {
    return null;
  }
  // A blob: URL, which Next's image component can't load.
  return (
    <picture>
      <img src={url} alt={label} className="absolute inset-0 size-full object-cover" />
    </picture>
  );
}

/** A take just recorded, played back from memory before it's sent, captioned with its script. */
export function TakePreview(props: {
  take: Blob;
  label: string;
  script: Shot["script"];
  lang: string;
}) {
  return props.take.type.startsWith("image/") ? (
    <PhotoTake take={props.take} label={props.label} />
  ) : (
    <VideoTake {...props} />
  );
}
