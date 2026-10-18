/**
 * What a take looks like on the editor's board, worked out in the browser from the take
 * itself: frames along its kept part.
 */

/** A timeline thumbnail's size: 9:16, twice the strip's CSS height for sharp screens. */
const THUMB_HEIGHT = 128;
const THUMB_WIDTH = 72;
const THUMB_QUALITY = 0.7;

function once(target: HTMLVideoElement, event: "loadeddata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error("the take couldn't be read")), {
      once: true,
    });
  });
}

export interface Frame {
  seconds: number;
  /** A JPEG data: URL. */
  src: string;
}

/** Frames of the video at `url`, one at each of `times` (seconds), cropped to 9:16. */
export async function videoFrames(url: string, times: readonly number[]): Promise<Frame[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const loaded = once(video, "loadeddata");
  video.src = url;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("no canvas to draw on");
  }
  const frames: Frame[] = [];
  for (const time of times) {
    const seeked = once(video, "seeked");
    video.currentTime = time;
    await seeked;
    const scale = Math.max(THUMB_WIDTH / video.videoWidth, THUMB_HEIGHT / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    ctx.drawImage(video, (THUMB_WIDTH - w) / 2, (THUMB_HEIGHT - h) / 2, w, h);
    frames.push({ seconds: time, src: canvas.toDataURL("image/jpeg", THUMB_QUALITY) });
  }
  video.removeAttribute("src");
  video.load();
  return frames;
}
