"use client";

import type { Shot } from "@repo/contracts/api";
import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { bodyBox, framingHint } from "../lib/framing";
import { POSE_MATCH, poseScore, targetBody } from "../lib/pose";
import { handRaised } from "../lib/readiness";
import { usePose } from "./use-pose";

/** How long a hand must stay up to count: long enough that a wave or a stretch doesn't. */
const RAISE_MS = 0.7 * SECOND_MS;

/**
 * The pose outline, the framing hint and the member's position, for a shot with a person
 * in it, tracked while `live`; and, hands-free, a hand held up for a moment calls
 * `onRaise` (once per raise) so the member can start a take from across the room.
 */
export function useBodyGuides(
  shot: Shot,
  video: RefObject<HTMLVideoElement | null>,
  { live, camera, onRaise }: { live: boolean; camera: Shot["camera"]; onRaise: () => void },
) {
  const target = useMemo(() => targetBody(shot.pose), [shot]);
  const tracksBody = shot.pose.keypoints.length > 0;
  const pose = usePose(video, tracksBody && live);
  const score = pose.body ? poseScore(target, pose.body) : null;
  const box = pose.body ? bodyBox(pose.body) : null;
  const raised = live && handRaised(pose.body);
  const raise = useRef(onRaise);
  useEffect(() => {
    raise.current = onRaise;
  });
  useEffect(() => {
    if (!raised) {
      return;
    }
    const timer = window.setTimeout(() => raise.current(), RAISE_MS);
    return () => window.clearTimeout(timer);
  }, [raised]);
  return {
    target,
    tracksBody,
    state: pose.state,
    matched: score !== null && score >= POSE_MATCH,
    framing: tracksBody ? framingHint(shot.framing.subject, box, camera) : null,
    // Where they stand: the walking arrow starts at their feet.
    person: box ? { x: box.x + box.width / 2, y: Math.min(0.94, box.y + box.height) } : null,
  };
}
