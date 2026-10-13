/**
 * YouTube's privacy-enhanced embed (youtube-nocookie.com, in the CSP's frame-src), and
 * the commands its player takes over postMessage (the IFrame API's protocol, without
 * loading its script).
 */
const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

export interface EmbedOptions {
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  /** Only this part of the video, in seconds. */
  startSeconds?: number;
  endSeconds?: number;
  controls?: boolean;
}

export function embedUrl(videoId: string, options: EmbedOptions = {}): string {
  const params = new URLSearchParams({
    playsinline: "1",
    rel: "0",
    enablejsapi: "1",
    autoplay: options.autoplay ? "1" : "0",
    mute: options.muted ? "1" : "0",
    controls: options.controls ? "1" : "0",
  });
  if (options.loop) {
    // YouTube loops a single video only when it is its own playlist.
    params.set("loop", "1");
    params.set("playlist", videoId);
  }
  if (options.startSeconds !== undefined) {
    params.set("start", String(Math.floor(options.startSeconds)));
  }
  if (options.endSeconds !== undefined) {
    params.set("end", String(Math.ceil(options.endSeconds)));
  }
  return `${EMBED_ORIGIN}/embed/${videoId}?${params}`;
}

export type PlayerCommand = "mute" | "unMute" | "playVideo" | "pauseVideo";

export function sendCommand(frame: HTMLIFrameElement | null, command: PlayerCommand) {
  frame?.contentWindow?.postMessage(
    JSON.stringify({ event: "command", func: command, args: [] }),
    EMBED_ORIGIN,
  );
}

/** The link to a short on YouTube itself (to share, or to comment there). */
export const shortUrl = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`;
