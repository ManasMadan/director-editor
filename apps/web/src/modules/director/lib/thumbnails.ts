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

/** Whether nothing was drawn: a take's frames are opaque, an empty canvas isn't. */
const blank = (ctx: CanvasRenderingContext2D) =>
  ctx.getImageData(THUMB_WIDTH / 2, THUMB_HEIGHT / 2, 1, 1).data[3] === 0;

/**
 * Draws the video's frame at `time`, cropped to 9:16. Chrome hands a seeked frame to the
 * video's compositor on another thread, and on a busy machine it can get there after
 * `seeked`, when drawing draws nothing; so an empty canvas waits for the frame to be
 * presented and draws again. The frame callback is asked for before seeking, so it can't
 * miss that frame. It isn't waited for otherwise: a seek within the frame already shown
 * presents nothing new, and the callback would never come.
 */
async function drawAt(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, time: number) {
  let callback = 0;
  const shown = new Promise<void>((resolve) => {
    callback = video.requestVideoFrameCallback(() => resolve());
  });
  const seeked = once(video, "seeked");
  video.currentTime = time;
  await seeked;
  const scale = Math.max(THUMB_WIDTH / video.videoWidth, THUMB_HEIGHT / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const draw = () => {
    ctx.clearRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    ctx.drawImage(video, (THUMB_WIDTH - w) / 2, (THUMB_HEIGHT - h) / 2, w, h);
  };
  draw();
  if (blank(ctx)) {
    await shown;
    draw();
  }
  video.cancelVideoFrameCallback(callback);
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
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("no canvas to draw on");
  }
  const frames: Frame[] = [];
  for (const time of times) {
    await drawAt(ctx, video, time);
    frames.push({ seconds: time, src: canvas.toDataURL("image/jpeg", THUMB_QUALITY) });
  }
  video.removeAttribute("src");
  video.load();
  return frames;
}
