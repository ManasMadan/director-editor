/**
 * Puts the picked takes together into the finished video, in the browser: each video's
 * best part (as Gemini kept it) and each photo, in the plan's order, drawn onto a 9:16
 * canvas and recorded with the takes' own sound, the captions burned into every frame.
 * Rendering takes as long as the video plays; the editor then saves it to My media.
 *
 * The takes are read through short-lived storage URLs (fetched, so the canvas stays
 * CORS-clean: a canvas that drew a cross-origin video can't be recorded).
 */
import { uploadPurposes } from "@repo/contracts/files";
import { type CaptionInk, drawCaption } from "./caption-draw";
import { type CaptionLine, type CaptionStyle, captionAt } from "./captions";
import type { Composer, Picture } from "./compose";
import { recorderFormat } from "./media";

export const OUTPUT_WIDTH = 720;
export const OUTPUT_HEIGHT = 1280;
/**
 * About 4 Mbit/s of picture and 128 kbit/s of sound, for 720×1280 with captions: a
 * 3-minute Short comes to about 93 MB, inside a saved video's 100 MB upload (the virus
 * scanner's stream limit). Raising either means raising that limit with it.
 */
const VIDEO_BITS_PER_SECOND = 4_000_000;
const AUDIO_BITS_PER_SECOND = 128_000;
/** The longest video that fits a saved video's upload at those rates. */
export const MAX_SECONDS =
  (uploadPurposes["director-cut-video"].maxBytes * 8) /
  (VIDEO_BITS_PER_SECOND + AUDIO_BITS_PER_SECOND);
const FPS = 30;
/** How much a photo slowly zooms in over its time on screen. */
const PHOTO_ZOOM = 0.06;

/**
 * How a clip is drawn when a match cut lines it up (lib/match-cuts.ts): scaled and turned
 * clockwise (degrees) about the frame's centre, then moved, in the frame's pixels.
 */
export interface FrameTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** `filter` is a canvas filter for the segment's picture (its grade, lib/grades.ts). */
export type Segment =
  | {
      kind: "video";
      source: Blob;
      startSeconds: number;
      endSeconds: number;
      transform?: FrameTransform | undefined;
      filter?: string;
    }
  | { kind: "photo"; source: Blob; seconds: number; filter?: string }
  /** A skipped shot: no take, its picture painted by the look (a gap's B-roll or a held frame). */
  | { kind: "gap"; seconds: number };

/** Canvas filters together, for a grade on top of another filter. */
function filters(...each: (string | undefined)[]) {
  const used = each.filter((one) => one !== undefined && one !== "none");
  return used.length > 0 ? used.join(" ") : "none";
}

/** Draws one frame of a photo in its grade, leaving the captions ungraded. */
function drawGraded(
  ctx: CanvasRenderingContext2D,
  picture: CanvasImageSource,
  rect: { x: number; y: number; w: number; h: number },
  filter: string | undefined,
) {
  ctx.filter = filters(filter);
  ctx.drawImage(picture, rect.x, rect.y, rect.w, rect.h);
  ctx.filter = "none";
}

/** Sets `ctx` up to draw the frame with `transform` applied (the CSS preview's maths). */
export function applyTransform(
  ctx: Pick<CanvasRenderingContext2D, "translate" | "rotate" | "scale">,
  transform: FrameTransform,
) {
  ctx.translate(OUTPUT_WIDTH / 2 + transform.x, OUTPUT_HEIGHT / 2 + transform.y);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scale, transform.scale);
  ctx.translate(-OUTPUT_WIDTH / 2, -OUTPUT_HEIGHT / 2);
}

/** How much the edges a moved frame uncovers are blurred: a soft copy, never black. */
const EDGE_BLUR = "blur(24px)";

/**
 * A video segment's picture for this frame: the video itself, or, when a match cut lined
 * it up, the frame drawn moved onto a frame-sized canvas (the look then places it).
 */
function framed(
  video: HTMLVideoElement,
  transform: FrameTransform | undefined,
  grade: string | undefined,
  canvas: HTMLCanvasElement,
): Picture {
  if (!transform && grade === undefined) {
    return { source: video, width: video.videoWidth, height: video.videoHeight };
  }
  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  if (ctx) {
    drawFrame(ctx, video, coverRect(video.videoWidth, video.videoHeight), transform, grade);
  }
  return { source: canvas, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}

/** Draws one frame of a video segment, moved when a match cut lined it up. */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rect: ReturnType<typeof coverRect>,
  transform: FrameTransform | undefined,
  grade: string | undefined,
) {
  if (!transform) {
    drawGraded(ctx, video, rect, grade);
    return;
  }
  ctx.filter = filters(EDGE_BLUR, grade);
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
  ctx.save();
  ctx.filter = filters(grade);
  applyTransform(ctx, transform);
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
  ctx.filter = "none";
}

/** Where to draw a `width`×`height` picture so it covers the frame, cropped in the middle. */
export function coverRect(width: number, height: number, zoom = 1) {
  const scale = Math.max(OUTPUT_WIDTH / width, OUTPUT_HEIGHT / height) * zoom;
  const w = width * scale;
  const h = height * scale;
  return { x: (OUTPUT_WIDTH - w) / 2, y: (OUTPUT_HEIGHT - h) / 2, w, h };
}

/** The length of the finished short. */
export function totalSeconds(segments: Segment[]) {
  return segments.reduce(
    (sum, s) => sum + (s.kind === "video" ? s.endSeconds - s.startSeconds : s.seconds),
    0,
  );
}

export interface Captions {
  /** On the edit's clock (lib/edit.ts editLines). */
  lines: readonly CaptionLine[];
  style: CaptionStyle;
  ink: CaptionInk;
}

interface Stage {
  ctx: CanvasRenderingContext2D;
  audio: AudioContext;
  sound: MediaStreamAudioDestinationNode;
  recorder: MediaRecorder;
  withSound: boolean;
  /** Cancelling the render: the segment playing stops at its next frame. */
  signal: AbortSignal | undefined;
  /**
   * Draws the frame `seconds` into the current segment, with the camera's picture (null
   * in a gap): the plain picture, or the plan's look over it (lib/compose.ts).
   */
  onFrame: (seconds: number, picture: Picture | null) => void;
}

const cancelled = (stage: Stage) => stage.signal?.aborted === true;

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function playVideo(stage: Stage, segment: Extract<Segment, { kind: "video" }>) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(segment.source);
  try {
    video.src = url;
    video.playsInline = true;
    // Silent unless its sound goes into the short (then it plays only into the recording).
    video.muted = !stage.withSound;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("a take couldn't be read"));
    });
    if (stage.withSound) {
      stage.audio.createMediaElementSource(video).connect(stage.sound);
    }
    video.currentTime = segment.startSeconds;
    await new Promise((resolve) => {
      video.onseeked = resolve;
    });
    await video.play();
    // The recorder waited while the take loaded: no black or frozen gap between shots.
    stage.recorder.resume();
    // One frame-sized canvas for the segment's moved frames, reused frame after frame.
    const moved = document.createElement("canvas");
    moved.width = OUTPUT_WIDTH;
    moved.height = OUTPUT_HEIGHT;
    while (video.currentTime < segment.endSeconds && !video.ended && !cancelled(stage)) {
      stage.onFrame(
        video.currentTime - segment.startSeconds,
        framed(video, segment.transform, segment.filter, moved),
      );
      await nextFrame();
    }
    video.pause();
    stage.recorder.pause();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function showPhoto(stage: Stage, segment: Extract<Segment, { kind: "photo" }>) {
  const image = await createImageBitmap(segment.source);
  const frame = document.createElement("canvas");
  frame.width = OUTPUT_WIDTH;
  frame.height = OUTPUT_HEIGHT;
  stage.recorder.resume();
  const start = performance.now();
  for (;;) {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed >= segment.seconds || cancelled(stage)) {
      break;
    }
    const zoom = 1 + PHOTO_ZOOM * (elapsed / segment.seconds);
    // The push-in is the photo's own: it's drawn zoomed onto a frame-sized picture.
    stage.onFrame(elapsed, zoomed(frame, image, zoom, segment.filter));
    await nextFrame();
  }
  image.close();
  stage.recorder.pause();
}

/** A gap: the look paints it for its length, with no camera picture. */
async function showGap(stage: Stage, segment: Extract<Segment, { kind: "gap" }>) {
  stage.recorder.resume();
  const start = performance.now();
  for (;;) {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed >= segment.seconds || cancelled(stage)) {
      break;
    }
    stage.onFrame(elapsed, null);
    await nextFrame();
  }
  stage.recorder.pause();
}

/** `image` drawn covering a frame-sized canvas at `zoom`, as a picture to place. */
function zoomed(
  canvas: HTMLCanvasElement,
  image: ImageBitmap,
  zoom: number,
  grade: string | undefined,
): Picture {
  const ctx = canvas.getContext("2d");
  if (ctx) {
    drawGraded(ctx, image, coverRect(image.width, image.height, zoom), grade);
  }
  return { source: canvas, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}

function drawPlain(ctx: CanvasRenderingContext2D, picture: Picture | null) {
  if (!picture) {
    return;
  }
  const rect = coverRect(picture.width, picture.height);
  ctx.drawImage(picture.source, rect.x, rect.y, rect.w, rect.h);
}

/**
 * Renders the short; `onProgress` hears how far it is, from 0 to 1. With `withSound`
 * false (the member used the original's audio), the result is silent: YouTube adds the
 * original sound when it is posted ("Use this sound"). `audio` is made and resumed in the
 * click that asked for the short: Safari starts audio only inside a tap, and by the time
 * the takes are downloaded the tap is over.
 */
export async function stitch(
  segments: Segment[],
  {
    audio,
    withSound,
    onProgress,
    captions,
    signal,
    look,
  }: {
    audio: AudioContext;
    withSound: boolean;
    onProgress: (done: number) => void;
    captions: Captions;
    /**
     * Cancels the render (the member pressed Cancel or left): the recorder stops, the
     * take playing is paused, and the promise rejects with an AbortError.
     */
    signal?: AbortSignal;
    /**
     * The plan's look (lib/compose.ts): layout, assets, grades, words, gaps and the end
     * card, painted on the edit's clock. Without it, each picture fills the frame.
     */
    look?: (ctx: CanvasRenderingContext2D) => Composer;
  },
): Promise<Blob> {
  const format = recorderFormat();
  if (!format) {
    throw new Error("this browser can't record video");
  }
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("no canvas to draw on");
  }
  const sound = audio.createMediaStreamDestination();
  const tracks = [
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...(withSound ? sound.stream.getAudioTracks() : []),
  ];
  const recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType: format.mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const total = totalSeconds(segments);
  // Where the current segment starts in the short: frames are captioned on its clock.
  let offset = 0;
  const painter = look?.(ctx);
  const stage: Stage = {
    ctx,
    audio,
    sound,
    recorder,
    withSound,
    signal,
    onFrame: (seconds, picture) => {
      const at = offset + seconds;
      const captionsY = painter?.paint(at, picture);
      if (!painter) {
        drawPlain(ctx, picture);
      }
      const words = captionAt(captions.lines, at);
      drawCaption(ctx, OUTPUT_WIDTH, OUTPUT_HEIGHT, words, captions.style, captions.ink, captionsY);
      onProgress(Math.min(1, at / total));
    },
  };
  recorder.start(1000);
  // Paused until the first shot's first frame (each shot resumes it once it plays).
  recorder.pause();
  try {
    for (const segment of segments) {
      if (cancelled(stage)) {
        break;
      }
      if (segment.kind === "video") {
        await playVideo(stage, segment);
      } else if (segment.kind === "photo") {
        await showPhoto(stage, segment);
      } else {
        await showGap(stage, segment);
      }
      offset += totalSeconds([segment]);
    }
  } finally {
    painter?.stop();
    recorder.stop();
    await stopped;
    // `audio` is the caller's (made in its tap), so the caller closes it.
  }
  signal?.throwIfAborted();
  onProgress(1);
  return new Blob(chunks, { type: format.uploadType });
}
