"use client";

import { forwardRef } from "react";
import { type EmbedOptions, embedUrl } from "../lib/embed";

/** A YouTube short, playing in YouTube's own (privacy-enhanced) player. */
export const YouTubeEmbed = forwardRef<
  HTMLIFrameElement,
  {
    videoId: string;
    title: string;
    options?: EmbedOptions;
    className?: string;
    /**
     * False for a player the page drives with its own buttons (it takes no taps): then
     * YouTube's own controls aren't a dozen Tab stops before the page's.
     */
    focusable?: boolean;
  }
>(function YouTubeEmbed({ videoId, title, options, className, focusable = true }, ref) {
  return (
    <iframe
      ref={ref}
      src={embedUrl(videoId, options)}
      title={title}
      className={className}
      tabIndex={focusable ? undefined : -1}
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
  );
});
