"use client";

import { forwardRef } from "react";
import { type EmbedOptions, embedUrl } from "../lib/embed";

/** A YouTube short, playing in YouTube's own (privacy-enhanced) player. */
export const YouTubeEmbed = forwardRef<
  HTMLIFrameElement,
  { videoId: string; title: string; options?: EmbedOptions; className?: string }
>(function YouTubeEmbed({ videoId, title, options, className }, ref) {
  return (
    <iframe
      ref={ref}
      src={embedUrl(videoId, options)}
      title={title}
      className={className}
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
  );
});
