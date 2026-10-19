/**
 * How much picture a recording holds, read back in the browser: when its last frame is.
 * The container's duration doesn't say, as it's the longer of the picture and the sound,
 * and the picture is what a recorder can cut short (lib/drain.ts). So the recording is
 * opened in a video element, moved to its end, and the frame shown there is asked when
 * it is.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { loadedVideo } from "./media";

/** How long the frame at the end may take to show before the browser is taken not to say. */
const FRAME_WAIT_MS = 3 * SECOND_MS;
/** Past any recording's end: where a WebM with no duration in it is moved to find its end. */
const FAR_END_SECONDS = 1e9;

/** The time of the frame shown once `video` is moved to its end; null when none shows. */
function frameAtEnd(video: HTMLVideoElement): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FRAME_WAIT_MS);
    video.requestVideoFrameCallback((_, metadata) => {
      clearTimeout(timer);
      resolve(metadata.mediaTime);
    });
    video.currentTime = Number.isFinite(video.duration) ? video.duration : FAR_END_SECONDS;
  });
}

/**
 * When the recording's last frame is, in seconds: 0 while nothing of it can be read yet,
 * null where this browser can't say (no frame callbacks, or no frame shown in time).
 */
export async function lastFrameSeconds(recording: Blob): Promise<number | null> {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    return null;
  }
  const url = URL.createObjectURL(recording);
  try {
    const video = await loadedVideo(url).catch(() => null);
    if (!video) {
      // Not a playable recording yet: the recorder hasn't written its first piece.
      return 0;
    }
    const seconds = await frameAtEnd(video);
    video.removeAttribute("src");
    video.load();
    return seconds;
  } finally {
    URL.revokeObjectURL(url);
  }
}
