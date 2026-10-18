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

export type Segment =
  | { kind: "video"; source: Blob; startSeconds: number; endSeconds: number }
  | { kind: "photo"; source: Blob; seconds: number };

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
  /** Called after each frame is drawn, `seconds` into the current segment. */
  onFrame: (seconds: number) => void;
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
    const rect = coverRect(video.videoWidth, video.videoHeight);
    while (video.currentTime < segment.endSeconds && !video.ended && !cancelled(stage)) {
      stage.ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
      stage.onFrame(video.currentTime - segment.startSeconds);
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
  stage.recorder.resume();
  const start = performance.now();
  for (;;) {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed >= segment.seconds || cancelled(stage)) {
      break;
    }
    const zoom = 1 + PHOTO_ZOOM * (elapsed / segment.seconds);
    const rect = coverRect(image.width, image.height, zoom);
    stage.ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    stage.onFrame(elapsed);
    await nextFrame();
  }
  image.close();
  stage.recorder.pause();
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
  const stage: Stage = {
    ctx,
    audio,
    sound,
    recorder,
    withSound,
    signal,
    onFrame: (seconds) => {
      const at = offset + seconds;
      const words = captionAt(captions.lines, at);
      drawCaption(ctx, OUTPUT_WIDTH, OUTPUT_HEIGHT, words, captions.style, captions.ink);
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
      await (segment.kind === "video" ? playVideo(stage, segment) : showPhoto(stage, segment));
      offset += totalSeconds([segment]);
    }
  } finally {
    recorder.stop();
    await stopped;
    // `audio` is the caller's (made in its tap), so the caller closes it.
  }
  signal?.throwIfAborted();
  onProgress(1);
  return new Blob(chunks, { type: format.uploadType });
}
