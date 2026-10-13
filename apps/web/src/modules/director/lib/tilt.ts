/**
 * How the phone is held, from the browser's DeviceOrientation event, in the terms a shot
 * plan uses (packages/contracts director `phoneAngle`), for a phone upright in portrait:
 *
 *   beta  0 lying flat screen up, 90 standing upright, more when the top tips back
 *   gamma  the lean left (-) or right (+), up to 90
 *
 * The back camera looks out of the phone's back: flat on a table it points at the floor
 * (pitch -90), upright at the horizon (0). The front camera looks the other way.
 */
import type { Shot } from "@repo/contracts/api";

export interface Tilt {
  /** Degrees the camera points above (+) or below (-) the horizon. */
  pitch: number;
  /** Degrees the phone leans clockwise (+) from upright. */
  roll: number;
}

export function tiltFromOrientation(beta: number, gamma: number, camera: Shot["camera"]): Tilt {
  const pitch = camera === "back" ? beta - 90 : 90 - beta;
  return { pitch: clamp(pitch, -90, 90), roll: clamp(gamma, -90, 90) };
}

/** How far off the target each axis is (positive: tip up / lean right to fix it). */
export function tiltOffset(tilt: Tilt, target: Shot["phoneAngle"]): Tilt {
  return { pitch: target.pitch - tilt.pitch, roll: target.roll - tilt.roll };
}

export function tiltInRange(tilt: Tilt, target: Shot["phoneAngle"]): boolean {
  const offset = tiltOffset(tilt, target);
  return Math.abs(offset.pitch) <= target.tolerance && Math.abs(offset.roll) <= target.tolerance;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}
