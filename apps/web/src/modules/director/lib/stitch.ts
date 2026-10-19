/**
 * Puts the edit together into the finished video, in the browser: each video's best part
 * (as Gemini kept it), each photo and each gap, in the edit's order, drawn onto a 9:16
 * canvas with the plan's look and the captions burned in, with the takes' own sound. The
 * editor then saves it to My media.
 *
 * The timeline is fixed before anything plays (lib/render-plan.ts): whole frames for each
 * segment, and one soundtrack decoded from the takes and cut to exactly those frames.
 * Then one clock drives the render, the render's AudioContext, which plays that soundtrack
 * into the recorder: each frame is drawn when the clock reaches it and handed to the
 * recorder there and then (`requestFrame`), a held picture as much as a moving one. So
 * the picture can't drift from the sound, and no frame lasts longer than the frame rate's
 * (a canvas otherwise sends the recorder a frame only when the browser sees it change).
 * The recorder runs from the first frame to the last without pausing: every take is
 * loaded and cued at its part's start before the render starts, so there's nothing to
 * wait for between segments.
 *
 * MediaRecorder records in real time, so a render takes as long as the video plays. A
 * hidden page (the phone locked, another app or tab) draws nothing, so the render pauses
 * then, the clock, the sound and the recorder together, and carries on when the page is
 * back; the screen is kept on meanwhile where the browser lets it.
 *
 * Its encoder can fall behind on a busy device, and the frames it hasn't encoded when the
 * recorder stops are lost. So after the last frame the render waits for it to catch up
 * ("finishing", lib/drain.ts), then checks the file: one with less picture than the edit
 * is an IncompleteRender, never a video to save. The editor tries once more at the
 * lighter quality, which halves the encoder's work, before saying so.
 *
 * The takes are read from blobs (fetched through short-lived storage URLs, so the canvas
 * stays CORS-clean: a canvas that drew a cross-origin video can't be recorded).
 */
import { uploadPurposes } from "@repo/contracts/files";
import { required } from "@repo/contracts/objects";
import { SECOND_MS } from "@repo/contracts/time";
import { type CaptionInk, drawCaption } from "./caption-draw";
import { type CaptionLine, type CaptionStyle, captionAt } from "./captions";
import type { Composer, Picture } from "./compose";
import { caughtUp, type Written } from "./drain";
import { loadedVideo, recorderFormat } from "./media";
import { lastFrameSeconds } from "./recorded";
import {
  FPS,
  mixDown,
  mixInto,
  type RenderPlan,
  renderPlan,
  samplesOf,
  segmentAt,
} from "./render-plan";
import { keepScreenOn } from "./wake-lock";

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
/**
 * How the video is encoded: as it's saved, or lighter (540×960 at half the bitrate,
 * about half the encoder's work) for a second try on a device whose encoder fell behind.
 */
export type RenderQuality = "full" | "light";
const QUALITIES: Record<RenderQuality, { scale: number; videoBitsPerSecond: number }> = {
  full: { scale: 1, videoBitsPerSecond: VIDEO_BITS_PER_SECOND },
  light: { scale: 0.75, videoBitsPerSecond: VIDEO_BITS_PER_SECOND / 2 },
};
/** How often the recording is checked while its encoder catches up. */
const DRAIN_CHECK_MS = 500;

/**
 * The recording came out with less picture than the edit: the encoder fell too far
 * behind (a busy device), and what it hadn't encoded was lost. Not a video to save.
 */
export class IncompleteRender extends Error {
  override name = "IncompleteRender";
}

/** How much a photo slowly zooms in over its time on screen. */
const PHOTO_ZOOM = 0.06;
/**
 * How far a take's picture may drift from the render's clock before it's moved back in
 * step. It plays at the clock's pace, so it only drifts when the page was busy.
 */
const DRIFT_SECONDS = 2 / FPS;

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

/** How long a segment plays in the edit. */
const lengthOf = (segment: Segment) =>
  segment.kind === "video" ? segment.endSeconds - segment.startSeconds : segment.seconds;

/** The length of the finished short. */
export function totalSeconds(segments: Segment[]) {
  return segments.reduce((sum, segment) => sum + lengthOf(segment), 0);
}

/** How long the video of `segments` comes out: whole frames, as the render lays them. */
export function renderedSeconds(segments: Segment[]) {
  const plan = renderPlan(segments, lengthOf);
  return plan.frames / plan.fps;
}

export interface Captions {
  /** On the edit's clock (lib/edit.ts editLines). */
  lines: readonly CaptionLine[];
  style: CaptionStyle;
  ink: CaptionInk;
}

/** A segment, ready before the render starts. */
interface Cued {
  /** Its picture `seconds` into it; null in a gap, which the look paints. */
  pictureAt: (seconds: number) => Picture | null;
  /** Its first frame is up: a take starts playing. */
  begin: () => void;
  /** Its last frame is done: a take stops. */
  end: () => void;
  release: () => void;
}

const STILL: Omit<Cued, "pictureAt"> = {
  begin: () => undefined,
  end: () => undefined,
  release: () => undefined,
};

function seek(video: HTMLVideoElement, seconds: number) {
  return new Promise((resolve) => {
    video.onseeked = resolve;
    video.currentTime = seconds;
  });
}

/**
 * Moves the take back in step when it drifted from `wanted` (the clock's place in it).
 * Past the take's end its last frame holds: the part ran longer than the take.
 */
function keepInStep(video: HTMLVideoElement, wanted: number) {
  if (video.seeking || (video.ended && wanted >= video.currentTime)) {
    return;
  }
  if (Math.abs(video.currentTime - wanted) > DRIFT_SECONDS) {
    video.currentTime = wanted;
  }
}

/** A take, loaded and cued at its part's start. `scratch` is a frame-sized canvas. */
async function cueTake(
  segment: Extract<Segment, { kind: "video" }>,
  scratch: HTMLCanvasElement,
): Promise<Cued> {
  const url = URL.createObjectURL(segment.source);
  let video: HTMLVideoElement;
  try {
    video = await loadedVideo(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error("a take couldn't be read", { cause: error });
  }
  await seek(video, segment.startSeconds);
  return {
    pictureAt: (seconds) => {
      keepInStep(video, segment.startSeconds + seconds);
      return framed(video, segment.transform, segment.filter, scratch);
    },
    begin: () => {
      // Muted, so nothing stops it playing; if it's refused all the same, the picture
      // still follows the clock, moved along a frame or two at a time.
      video.play().catch(() => video.pause());
    },
    end: () => video.pause(),
    release: () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** A photo, decoded, slowly pushing in over its `seconds`. */
async function cuePhoto(
  segment: Extract<Segment, { kind: "photo" }>,
  scratch: HTMLCanvasElement,
): Promise<Cued> {
  const image = await createImageBitmap(segment.source);
  return {
    ...STILL,
    pictureAt: (seconds) =>
      zoomed(scratch, image, 1 + PHOTO_ZOOM * (seconds / segment.seconds), segment.filter),
    release: () => image.close(),
  };
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

/** Every segment ready to show, in order; what's cued already is let go of on a failure. */
async function cueAll(plan: RenderPlan<Segment>, scratch: HTMLCanvasElement) {
  const cued: Cued[] = [];
  try {
    for (const { segment } of plan.placed) {
      if (segment.kind === "video") {
        cued.push(await cueTake(segment, scratch));
      } else if (segment.kind === "photo") {
        cued.push(await cuePhoto(segment, scratch));
      } else {
        cued.push({ ...STILL, pictureAt: () => null });
      }
    }
    return cued;
  } catch (error) {
    releaseAll(cued);
    throw error;
  }
}

function releaseAll(cued: readonly Cued[]) {
  for (const one of cued) {
    one.release();
  }
}

/** A take's sound, decoded at the render's rate in one channel; null for a silent take. */
async function soundOf(audio: AudioContext, take: Blob): Promise<Float32Array | null> {
  try {
    const decoded = await audio.decodeAudioData(await take.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    );
    return mixDown(channels);
  } catch {
    // No sound track (a take filmed without the microphone): its part plays silent.
    return null;
  }
}

/**
 * The video's soundtrack: each take's part decoded and cut to its segment's frames,
 * silence for photos and gaps. One take is decoded at a time, so a long video doesn't
 * hold every take's sound at once.
 */
async function soundtrackOf(plan: RenderPlan<Segment>, audio: AudioContext, lag: number) {
  const rate = audio.sampleRate;
  // Silent for `lag` frames after the end, the time the last frame is held: the sound
  // keeps flowing until the end of it has reached the recorder, and stops with the
  // picture, so waiting for the encoder after that records no more sound.
  const { length } = samplesOf(plan, { firstFrame: 0, frames: plan.frames + lag }, rate);
  const samples = new Float32Array(length);
  for (const placed of plan.placed) {
    const { segment } = placed;
    const sound = segment.kind === "video" ? await soundOf(audio, segment.source) : null;
    if (segment.kind === "video" && sound) {
      const from = Math.round(segment.startSeconds * rate);
      mixInto(samples, { ...samplesOf(plan, placed, rate), source: sound, from });
    }
  }
  const buffer = audio.createBuffer(1, Math.max(1, length), rate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

/**
 * The canvas as a video track that sends a frame each time it's asked to. Where a
 * browser can't be asked, the canvas is sampled at the frame rate instead, which sends a
 * frame only when the browser sees the canvas change.
 */
function canvasTrack(canvas: HTMLCanvasElement) {
  const askable = typeof CanvasCaptureMediaStreamTrack !== "undefined";
  const [track] = canvas.captureStream(askable ? 0 : FPS).getVideoTracks();
  if (askable && track instanceof CanvasCaptureMediaStreamTrack) {
    return { track, sendFrame: () => track.requestFrame() };
  }
  return { track: required(track, "the canvas's video track"), sendFrame: () => undefined };
}

/** Resolves once the page is visible: a hidden page draws nothing. */
function visible() {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", check);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", check);
    check();
  });
}

/**
 * Pauses the render while the page is hidden: the recorder, and the clock with the sound
 * (the AudioContext suspended), so the video carries on from the same frame and sound
 * sample when the page is back. Returns how to stop watching.
 */
function pauseWhileHidden(audio: AudioContext, recorder: MediaRecorder) {
  const changed = () => {
    if (document.visibilityState !== "visible") {
      if (recorder.state === "recording") {
        recorder.pause();
      }
      void audio.suspend();
      return;
    }
    void audio.resume().then(() => {
      if (recorder.state === "paused") {
        recorder.resume();
      }
    });
  };
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
}

/**
 * How long the sound the AudioContext plays now takes to reach the recorder, which
 * starts both tracks when it starts. A frame reaches it as it's drawn, so the picture's
 * clock runs this much behind the sound's, or every cut would be heard late.
 */
function soundDelay(audio: AudioContext) {
  return audio.baseLatency + (audio.outputLatency || 0);
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Paints each frame of the video; returns where its captions sit (undefined: the default). */
interface Painter {
  paint: (at: number, camera: Picture | null) => number | undefined;
  stop: () => void;
}

/**
 * The look without the plan's: each picture fills the frame, and a gap holds the last
 * one. Like the plan's look, it paints every frame afresh from the background up: Chrome
 * sends the recorder a requested frame only when the canvas was drawn on since the last.
 */
function plainLook(ctx: CanvasRenderingContext2D): Painter {
  const held = document.createElement("canvas");
  held.width = OUTPUT_WIDTH;
  held.height = OUTPUT_HEIGHT;
  const heldCtx = held.getContext("2d");
  let holding: Picture | null = null;
  return {
    paint: (_at, picture) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      const shown = picture ?? holding;
      if (shown) {
        const rect = coverRect(shown.width, shown.height);
        ctx.drawImage(shown.source, rect.x, rect.y, rect.w, rect.h);
      }
      if (picture && heldCtx) {
        heldCtx.drawImage(ctx.canvas, 0, 0);
        holding = { source: held, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
      }
      return undefined;
    },
    stop: () => undefined,
  };
}

interface Run {
  plan: RenderPlan<Segment>;
  cued: readonly Cued[];
  audio: AudioContext;
  /** When the soundtrack started, on the audio clock. */
  start: number;
  /**
   * How many frames the picture runs behind the clock: as long as the sound takes to
   * reach the recorder (soundDelay), so a cut is seen when it's heard.
   */
  lag: number;
  /** Draws frame `frame` (`seconds` into segment `index`) and sends it to the recorder. */
  draw: (frame: number, index: number, seconds: number) => void;
  signal: AbortSignal | undefined;
}

/** How many frames the recording holds once played through: the edit's, and the lag twice. */
const recordedFrames = (plan: RenderPlan<Segment>, lag: number) => plan.frames + 2 * lag;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits, after the last frame, until the recorder's encoder has caught up (lib/drain.ts)
 * or for twice the video's length and ten seconds more, whichever comes first.
 */
async function drain(
  written: () => Promise<Blob>,
  frames: number,
  fps: number,
  signal?: AbortSignal,
) {
  const expected = frames / fps;
  const started = performance.now();
  const cap = (2 * expected + 10) * SECOND_MS;
  const checks: Written[] = [];
  for (;;) {
    const last = await lastFrameSeconds(await written());
    if (last === null) {
      // This browser can't say how far it's got: stop now, the file is checked anyway.
      return;
    }
    checks.push({ at: performance.now() - started, picture: last + 1 / fps });
    if (
      caughtUp(checks, expected, 1 / fps) ||
      performance.now() - started > cap ||
      signal?.aborted
    ) {
      return;
    }
    await delay(DRAIN_CHECK_MS);
  }
}

/**
 * The finished file, checked: its picture runs to the edit's last frame (`frames` of it,
 * after the `lag` frames it starts with), or it's an IncompleteRender.
 */
async function checked(video: Blob, frames: number, lag: number, fps: number) {
  const last = await lastFrameSeconds(video);
  if (last !== null && last < (lag + frames - 2) / fps) {
    throw new IncompleteRender(`its picture ends at ${last} s of ${(lag + frames) / fps} s`);
  }
  return video;
}

/**
 * Draws a frame each time the clock reaches the next one, from the moment the recorder
 * starts: frame 0 while the sound is still on its way, then the video's frames `lag`
 * behind the clock, then its last frame again for `lag` more, while the end of the
 * sound reaches the recorder (a recorder that stops drops the sound still on its way).
 */
async function playThrough({ plan, cued, audio, start, lag, draw, signal }: Run) {
  if (plan.frames === 0) {
    return;
  }
  let drawn = -1;
  let showing = -1;
  for (;;) {
    const tick = Math.floor((audio.currentTime - start) * plan.fps);
    if (tick >= plan.frames + 2 * lag || signal?.aborted) {
      break;
    }
    if (tick > drawn) {
      const frame = Math.min(plan.frames - 1, Math.max(0, tick - lag));
      const index = segmentAt(plan, frame);
      if (index !== showing) {
        cued[showing]?.end();
        cued[index]?.begin();
        showing = index;
      }
      const placed = required(plan.placed[index], "the segment at a frame in the video");
      draw(frame, index, (frame - placed.firstFrame) / plan.fps);
      drawn = tick;
    }
    await nextFrame();
  }
  cued[showing]?.end();
}

interface Options {
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
  /** As it's saved, or lighter for a second try (RenderQuality). */
  quality?: RenderQuality;
  /** The last frame is drawn: the render waits for the recorder to finish writing. */
  onFinishing?: () => void;
}

/** The options MediaRecorder takes, with the keyframe interval Chrome reads. */
interface RecorderOptions extends MediaRecorderOptions {
  videoKeyFrameIntervalDuration?: number;
}

/**
 * The canvas the recorder records: the drawing canvas itself, or for a lighter render a
 * smaller copy of it, drawn as each frame is sent.
 */
function capturedCanvas(canvas: HTMLCanvasElement, scale: number) {
  if (scale === 1) {
    return { captured: canvas, copy: () => undefined };
  }
  const small = document.createElement("canvas");
  small.width = Math.round(OUTPUT_WIDTH * scale);
  small.height = Math.round(OUTPUT_HEIGHT * scale);
  const smallCtx = small.getContext("2d");
  return {
    captured: small,
    copy: () => smallCtx?.drawImage(canvas, 0, 0, small.width, small.height),
  };
}

/** The canvas the video is drawn on, the recorder recording it, and its finished file. */
function recorderOf(withSound: boolean, audio: AudioContext, quality: RenderQuality) {
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
  const { scale, videoBitsPerSecond } = QUALITIES[quality];
  const { captured, copy } = capturedCanvas(canvas, scale);
  const { track, sendFrame: send } = canvasTrack(captured);
  const tracks = [track, ...(withSound ? sound.stream.getAudioTracks() : [])];
  const options: RecorderOptions = {
    mimeType: format.mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    // A keyframe a second: the recording is written in pieces that short where Chrome
    // honours it, so the wait after the last frame sees the encoder's progress closely.
    videoKeyFrameIntervalDuration: SECOND_MS,
  };
  const recorder = new MediaRecorder(new MediaStream(tracks), options);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  /** What's been written so far, once the recorder has handed over what it holds. */
  const written = () =>
    new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        "dataavailable",
        () => resolve(new Blob(chunks, { type: format.uploadType })),
        { once: true },
      );
      recorder.requestData();
    });
  const file = async () => {
    await stopped;
    return new Blob(chunks, { type: format.uploadType });
  };
  const sendFrame = () => {
    copy();
    send();
  };
  return { ctx, sound, sendFrame, recorder, written, file };
}

/**
 * Renders the short; `onProgress` hears how far it is, from 0 to 1. With `withSound`
 * false (the member used the original's audio), the result is silent: YouTube adds the
 * original sound when it is posted ("Use this sound"). `audio` is made and resumed in the
 * click that asked for the short (Safari starts audio only inside a tap, and by the time
 * the takes are downloaded the tap is over); its clock times the render.
 */
export async function stitch(segments: Segment[], options: Options): Promise<Blob> {
  const { audio, withSound, onProgress, captions, signal, look } = options;
  const { ctx, sound, sendFrame, recorder, written, file } = recorderOf(
    withSound,
    audio,
    options.quality ?? "full",
  );
  const plan = renderPlan(segments, lengthOf);
  signal?.throwIfAborted();
  const scratch = document.createElement("canvas");
  scratch.width = OUTPUT_WIDTH;
  scratch.height = OUTPUT_HEIGHT;
  const cued = await cueAll(plan, scratch);
  const painter: Painter = look?.(ctx) ?? plainLook(ctx);
  const source = audio.createBufferSource();
  const stopWatching = pauseWhileHidden(audio, recorder);
  const letScreenLock = keepScreenOn();
  // The picture runs a whole number of frames behind the sound, as long as the sound
  // takes to reach the recorder, or every cut would be heard late.
  const lag = Math.ceil(soundDelay(audio) * plan.fps);
  try {
    if (withSound) {
      source.buffer = await soundtrackOf(plan, audio, lag);
      source.connect(sound);
    }
    await visible();
    // Running already (the tap that asked for the video started it), unless the page was
    // hidden while the takes loaded, which suspends it.
    await audio.resume();
    signal?.throwIfAborted();
    const draw = (frame: number, index: number, seconds: number) => {
      const at = frame / plan.fps;
      const picture = required(cued[index], "a cued segment").pictureAt(seconds);
      const captionsY = painter.paint(at, picture);
      const words = captionAt(captions.lines, at);
      drawCaption(ctx, OUTPUT_WIDTH, OUTPUT_HEIGHT, words, captions.style, captions.ink, captionsY);
      sendFrame();
      onProgress(frame / plan.frames);
    };
    recorder.start(1000);
    source.start();
    await playThrough({ plan, cued, audio, start: audio.currentTime, lag, draw, signal });
    if (plan.frames > 0 && !signal?.aborted) {
      options.onFinishing?.();
      // Not paused while it waits: Chrome drops the frames still being encoded then.
      await drain(written, recordedFrames(plan, lag), plan.fps, signal);
    }
  } finally {
    stopWatching();
    letScreenLock();
    painter.stop();
    releaseAll(cued);
    if (recorder.state !== "inactive") {
      source.stop();
      recorder.stop();
    }
  }
  const video = await file();
  signal?.throwIfAborted();
  onProgress(1);
  return plan.frames > 0 ? checked(video, plan.frames, lag, plan.fps) : video;
}
