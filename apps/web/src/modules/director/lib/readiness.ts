/**
 * The ready check: the four things a director checks before calling action (the spot,
 * the frame, the phone's angle, the light), each fine, still off, or not something this
 * shot or device can judge. The shot is ready when everything that can be judged is fine.
 */
import type { SceneCheck } from "@repo/contracts/api";
import { judgedLight, type Light } from "./frame-stats";
import type { FramingHint } from "./framing";
import type { Body } from "./pose";

export type Check = "ok" | "off" | "na";

export interface Readiness {
  spot: Check;
  frame: Check;
  angle: Check;
  light: Check;
}

export const CHECKS = ["spot", "frame", "angle", "light"] as const;

const judged = (value: boolean | null): Check => {
  if (value === null) {
    return "na";
  }
  return value ? "ok" : "off";
};

export function readinessOf({
  landmark,
  scene,
  offline,
  framing,
  level,
  light,
}: {
  /** What the shot's spot is next to ("tree"), when it has one. */
  landmark: string | null;
  scene: SceneCheck | null;
  offline: boolean;
  framing: FramingHint | null;
  /** Null without a tilt sensor. */
  level: boolean | null;
  /** The phone's own reading; Gemini's (from `scene`) counts when the phone sees no problem. */
  light: Light | null;
}): Readiness {
  const spotJudged = landmark !== null && !offline;
  const seenLight = judgedLight(light, scene);
  return {
    spot: judged(spotJudged ? scene?.inPlace === true : null),
    frame: judged(framing === null ? null : framing === "in-frame"),
    angle: judged(level),
    light: judged(seenLight === null ? null : seenLight === "good"),
  };
}

export function isReady(readiness: Readiness): boolean {
  const checks = CHECKS.map((check) => readiness[check]).filter((check) => check !== "na");
  return checks.length > 0 && checks.every((check) => check === "ok");
}

/** A hand held above the head: the hands-free "I'm ready, roll". */
export function handRaised(body: Body | null): boolean {
  const nose = body?.nose;
  if (!nose) {
    return false;
  }
  const above = (wrist: Body["left_wrist"]) => wrist !== undefined && wrist.y < nose.y - 0.03;
  return above(body.left_wrist) || above(body.right_wrist);
}
