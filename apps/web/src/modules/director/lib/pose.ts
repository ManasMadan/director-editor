/**
 * Bodies, as the plan describes them (13 named joints, fractions of the frame) and as
 * MediaPipe's pose landmarker finds them (33 landmarks): mapping one to the other, and how
 * closely a body matches the shot's pose.
 */
import { type KeypointName, keypointNames, type Shot } from "@repo/contracts/api";

export interface Point {
  x: number;
  y: number;
}
export type Body = Partial<Record<KeypointName, Point>>;

/** MediaPipe Pose's landmark index for each joint the plan names (the person's left). */
export const LANDMARK_INDEX: Record<KeypointName, number> = {
  nose: 0,
  left_shoulder: 11,
  right_shoulder: 12,
  left_elbow: 13,
  right_elbow: 14,
  left_wrist: 15,
  right_wrist: 16,
  left_hip: 23,
  right_hip: 24,
  left_knee: 25,
  right_knee: 26,
  left_ankle: 27,
  right_ankle: 28,
};

/** Below this, MediaPipe isn't sure the joint is in view. */
const MIN_VISIBILITY = 0.5;

/** The plan's joints out of MediaPipe's landmarks, leaving out the ones it can't see. */
export function bodyFromLandmarks(
  landmarks: readonly { x: number; y: number; visibility?: number }[],
): Body {
  const body: Body = {};
  for (const name of keypointNames) {
    const landmark = landmarks[LANDMARK_INDEX[name]];
    if (landmark && (landmark.visibility ?? 1) >= MIN_VISIBILITY) {
      body[name] = { x: landmark.x, y: landmark.y };
    }
  }
  return body;
}

export function targetBody(pose: Shot["pose"]): Body {
  return Object.fromEntries(pose.keypoints.map(({ name, x, y }) => [name, { x, y }]));
}

/** The bones a stick figure is drawn with, joint to joint. */
export const BONES: readonly [KeypointName, KeypointName][] = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

/** Joints centred on their middle and scaled to a unit spread, so size and place don't count. */
function normalized(points: Point[]): Point[] {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const spread = Math.sqrt(
    points.reduce((sum, p) => sum + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / points.length,
  );
  const scale = spread || 1;
  return points.map((p) => ({ x: (p.x - cx) / scale, y: (p.y - cy) / scale }));
}

/** At least this many joints in common before a pose can be judged. */
const MIN_SHARED = 4;
/** The average distance (in spreads) at which a pose counts as nothing like the target. */
const FAR = 0.8;
/** The score at which the outline locks. */
export const POSE_MATCH = 0.75;

/**
 * How closely `body` holds the target's pose, from 0 to 1: the shape of the joints both
 * have, wherever in the frame and however large (framing judges that). Null when there
 * aren't enough joints in common to say.
 */
export function poseScore(target: Body, body: Body): number | null {
  const shared = keypointNames.filter((name) => target[name] && body[name]);
  if (shared.length < MIN_SHARED) {
    return null;
  }
  const a = normalized(shared.flatMap((name) => target[name] ?? []));
  const b = normalized(shared.flatMap((name) => body[name] ?? []));
  const distance =
    a.reduce((sum, p, i) => sum + Math.hypot(p.x - (b[i]?.x ?? 0), p.y - (b[i]?.y ?? 0)), 0) /
    a.length;
  return Math.max(0, 1 - distance / FAR);
}
