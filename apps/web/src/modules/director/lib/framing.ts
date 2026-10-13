/**
 * Where the person stands against where the shot wants them (`framing.subject`), as a
 * direction to give. Boxes are fractions of the frame as the camera sees it; the front
 * camera's preview is mirrored, so "your left" is the frame's left there, and with the
 * back camera the person holding the phone aims it instead.
 */
import type { FrameBox, Shot } from "@repo/contracts/api";
import type { Body } from "./pose";

export type FramingHint =
  | "in-frame"
  | "not-seen"
  | "come-closer"
  | "step-back"
  | "step-left"
  | "step-right"
  | "aim-left"
  | "aim-right";

/** How far off centre (a fraction of the frame) or off size (a ratio) still frames it. */
const SHIFT = 0.1;
const TOO_SMALL = 0.75;
const TOO_LARGE = 1.3;

export function bodyBox(body: Body): FrameBox | null {
  const points = Object.values(body);
  if (points.length < 3) {
    return null;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  return {
    x,
    y,
    width: Math.max(0.01, Math.min(1, Math.max(...xs)) - x),
    height: Math.max(0.01, Math.min(1, Math.max(...ys)) - y),
  };
}

export function framingHint(
  target: FrameBox,
  actual: FrameBox | null,
  camera: Shot["camera"],
): FramingHint {
  if (!actual) {
    return "not-seen";
  }
  const ratio = actual.height / target.height;
  if (ratio < TOO_SMALL) {
    return "come-closer";
  }
  if (ratio > TOO_LARGE) {
    return "step-back";
  }
  // Positive: the person should sit further right in the frame the camera sees.
  const shift = target.x + target.width / 2 - (actual.x + actual.width / 2);
  if (Math.abs(shift) <= SHIFT) {
    return "in-frame";
  }
  if (camera === "front") {
    // Mirrored preview: moving to your own left moves you right in the camera's frame.
    return shift > 0 ? "step-left" : "step-right";
  }
  // Turning the phone left moves what it sees to the right of the frame.
  return shift > 0 ? "aim-left" : "aim-right";
}
