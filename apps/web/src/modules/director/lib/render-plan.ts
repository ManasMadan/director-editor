/**
 * The saved video's timeline, worked out before anything is drawn (lib/stitch.ts renders
 * it). Every segment gets a whole number of frames and exactly the run of sound samples
 * those frames last, so picture and sound start and end together at every cut, and the
 * whole video's sound is exactly as long as its picture. A picture that holds (a gap, a
 * photo, a take that ran out before its part did) is the same frame repeated at the frame
 * rate, never one long frame: players and YouTube freeze or drift on those.
 *
 * Cuts are rounded on the running total, so rounding never adds up into drift; a
 * segment too short to get a single frame is left out.
 */

/** The saved video's frame rate. */
export const FPS = 30;

interface Placed<T> {
  segment: T;
  /** The segment's first frame in the video, and how many frames it shows. */
  firstFrame: number;
  frames: number;
}

export interface RenderPlan<T> {
  placed: Placed<T>[];
  /** The video's length, in frames. */
  frames: number;
  fps: number;
}

/** Lays `segments` end to end, each `lengthOf` seconds long, in whole frames. */
export function renderPlan<T>(
  segments: readonly T[],
  lengthOf: (segment: T) => number,
  fps = FPS,
): RenderPlan<T> {
  const placed: Placed<T>[] = [];
  let seconds = 0;
  let frame = 0;
  for (const segment of segments) {
    seconds += Math.max(0, lengthOf(segment));
    const end = Math.round(seconds * fps);
    if (end > frame) {
      placed.push({ segment, firstFrame: frame, frames: end - frame });
      frame = end;
    }
  }
  return { placed, frames: frame, fps };
}

/** The segment showing `frame` (an index into `placed`), or -1 past the video's end. */
export function segmentAt<T>(plan: RenderPlan<T>, frame: number): number {
  return plan.placed.findIndex(
    (placed) => frame >= placed.firstFrame && frame < placed.firstFrame + placed.frames,
  );
}

/** The sound samples, at `rate` a second, that `frames` frames from `firstFrame` last. */
export function samplesOf(
  plan: Pick<RenderPlan<unknown>, "fps">,
  { firstFrame, frames }: { firstFrame: number; frames: number },
  rate: number,
): { start: number; length: number } {
  const start = Math.round((firstFrame * rate) / plan.fps);
  const end = Math.round(((firstFrame + frames) * rate) / plan.fps);
  return { start, length: end - start };
}

/** One take's sound placed in the soundtrack. */
export interface SoundPart {
  /** Where it starts in the soundtrack, and how many samples it lasts. */
  start: number;
  length: number;
  /** The take's sound, mixed down to one channel, and the sample its part starts at. */
  source: Float32Array;
  from: number;
}

/** About 5 ms at 48 kHz: long enough that a cut doesn't click, too short to hear as a fade. */
export const FADE_SAMPLES = 240;

/**
 * Copies `part` into its place in `soundtrack`: cut to its length, silent where the take's
 * sound runs out, and faded in and out over a few milliseconds so a cut doesn't click.
 */
export function mixInto(soundtrack: Float32Array, part: SoundPart, fade = FADE_SAMPLES) {
  const ramp = Math.min(fade, Math.floor(part.length / 2));
  const available = Math.max(0, Math.min(part.length, part.source.length - part.from));
  for (let i = 0; i < available; i += 1) {
    const edge = Math.min(i, part.length - 1 - i);
    const gain = edge < ramp ? edge / ramp : 1;
    soundtrack[part.start + i] = (part.source[part.from + i] ?? 0) * gain;
  }
}

/** The take's channels averaged into one: takes are a phone microphone's voice. */
export function mixDown(channels: readonly Float32Array[]): Float32Array {
  const [first] = channels;
  if (!first || channels.length === 1) {
    return first ?? new Float32Array(0);
  }
  const mono = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
    }
  }
  return mono;
}
