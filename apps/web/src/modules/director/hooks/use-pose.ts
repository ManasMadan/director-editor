"use client";

import { type RefObject, useEffect, useState } from "react";
import type { Body } from "../lib/pose";
import { createPoseDetector } from "../lib/pose-detector";
import { bodyInView } from "../lib/view";

export type PoseState = "off" | "loading" | "ready" | "failed";

/** About a dozen detections a second: smooth enough for an outline, light on a phone. */
const EVERY_MS = 80;

/** The person's joints on the camera, from MediaPipe, while `enabled` (null otherwise). */
export function usePose(video: RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [body, setBody] = useState<Body | null>(null);
  const [state, setState] = useState<PoseState>(enabled ? "loading" : "off");

  useEffect(() => {
    if (!enabled) {
      setState("off");
      setBody(null);
      return;
    }
    let stopped = false;
    let frame = 0;
    let closeDetector: (() => void) | null = null;
    setState("loading");
    createPoseDetector()
      .then((detector) => {
        closeDetector = () => detector.close();
        if (stopped) {
          detector.close();
          return;
        }
        setState("ready");
        let last = 0;
        const tick = (now: number) => {
          const element = video.current;
          if (element && element.readyState >= 2 && now - last >= EVERY_MS) {
            last = now;
            const found = detector.detect(element, now);
            // In the viewfinder's space, where the plan's outline and box are.
            setBody(found && bodyInView(found, element.videoWidth, element.videoHeight));
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch(() => setState("failed"));
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      closeDetector?.();
    };
  }, [enabled, video]);

  return { body, state };
}
