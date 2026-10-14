/**
 * What Director can tell from the camera on the phone itself, a few times a second and
 * with no model: how bright the picture is, whether the light is behind the subject, how
 * much the camera moves, and whether it's now looking somewhere new. These answer at once
 * (the scene check takes seconds), so Director reacts as the camera moves; the frames are
 * tiny (a few hundred pixels), so it costs nearly nothing.
 *
 * The thresholds are fixed, tuned on a laptop webcam and phones; if they misfire on some
 * camera, the upgrade is a rolling baseline per camera rather than new constants.
 */
import type { SceneCheck } from "@repo/contracts/api";

/** The sampled frame's size: 9:16, like the viewfinder. */
export const SAMPLE_WIDTH = 18;
export const SAMPLE_HEIGHT = 32;

const TOO_DARK = 0.2;
const TOO_BRIGHT = 0.86;
/** The edges this much brighter than the middle: a window or lamp behind the subject. */
const BACKLIT_GAP = 0.2;
/** Mean change per pixel between samples above which the camera is moving. */
export const SHAKY = 0.055;
/** Mean change from the last place Director looked at above which it's somewhere new. */
export const NEW_PLACE = 0.16;

export type Light = SceneCheck["lighting"];

/** Each pixel's brightness (Rec. 709 luma, 0 to 1) from RGBA bytes. */
export function lumaOf(rgba: Uint8ClampedArray): Float32Array {
  // Read through a view: it says where each byte is, with no gaps to guess around.
  const bytes = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const luma = new Float32Array(Math.floor(rgba.length / 4));
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    const at = pixel * 4;
    luma[pixel] =
      (0.2126 * bytes.getUint8(at) +
        0.7152 * bytes.getUint8(at + 1) +
        0.0722 * bytes.getUint8(at + 2)) /
      255;
  }
  return luma;
}

function mean(values: Float32Array, pick: (index: number) => boolean = () => true) {
  let sum = 0;
  let count = 0;
  for (const [index, value] of values.entries()) {
    if (pick(index)) {
      sum += value;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** How the frame is lit: overall, and the middle (where the subject is) against the edges. */
export function lightOf(luma: Float32Array, width = SAMPLE_WIDTH): Light {
  const height = Math.max(1, Math.floor(luma.length / width));
  const middle = (index: number) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;
  };
  const overall = mean(luma);
  const centre = mean(luma, middle);
  const edges = mean(luma, (index) => !middle(index));
  if (edges - centre > BACKLIT_GAP && edges > 0.45) {
    return "backlit";
  }
  if (overall < TOO_DARK) {
    return "too-dark";
  }
  return overall > TOO_BRIGHT ? "too-bright" : "good";
}

/** The mean change per pixel between two samples of the same size (0 the same, 1 inverted). */
export function difference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 1;
  }
  // Pixel by pixel. `b`'s pixel comes out of a one-pixel view of it: indexing a typed
  // array is typed as possibly missing, though the lengths match.
  const pixelOf = (index: number, fallback: number) =>
    b.subarray(index, index + 1).reduce((_, pixel) => pixel, fallback);
  return mean(a.map((value, index) => Math.abs(value - pixelOf(index, value))));
}

/**
 * A reading that has to hold for `needed` samples in a row before it counts, so one odd
 * frame (a flash, a hand passing) doesn't make Director change its mind.
 */
export function steadyReading<T>(needed: number) {
  let candidate: T | null = null;
  let count = 0;
  let settled: T | null = null;
  return (value: T): T | null => {
    if (value === candidate) {
      count += 1;
    } else {
      candidate = value;
      count = 1;
    }
    if (count >= needed) {
      settled = value;
    }
    return settled;
  };
}
