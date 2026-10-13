"use client";

import { useCheckSceneMutation } from "@repo/client/api/director/check-scene";
import type { SceneCheck } from "@repo/contracts/api";
import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useEffect, useRef, useState } from "react";
import { base64Of, captureFrame } from "../lib/media";

/** One frame every few seconds: the API allows 30 checks a minute. */
const EVERY_MS = 5 * SECOND_MS;
/** Each check costs the workspace's AI allowance: a camera left on stops asking after this. */
const MOST_CHECKS = 12;
const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.7;

/**
 * Gemini's direction to the shot's spot, from what the camera sees, every few seconds
 * while `active` (before recording starts). The last check stays until the next; the
 * camera screen is mounted afresh for each shot, so a shot never shows another's.
 */
export function useSceneGuide(
  video: RefObject<HTMLVideoElement | null>,
  { videoId, shotIndex, active }: { videoId: string; shotIndex: number; active: boolean },
) {
  const check = useCheckSceneMutation();
  const [scene, setScene] = useState<SceneCheck | null>(null);
  const busy = useRef(false);
  const checks = useRef(0);
  // Once Director says you're there, it stops looking.
  const settled = scene?.inPlace === true;
  const { mutateAsync } = check;

  useEffect(() => {
    if (!active || settled) {
      return;
    }
    const look = async () => {
      const element = video.current;
      if (
        busy.current ||
        !element ||
        element.readyState < 2 ||
        document.hidden ||
        checks.current >= MOST_CHECKS
      ) {
        return;
      }
      busy.current = true;
      checks.current += 1;
      try {
        const image = await base64Of(await captureFrame(element, FRAME_WIDTH, FRAME_QUALITY));
        setScene(await mutateAsync({ videoId, shotIndex, image }));
      } catch {
        // A missed check is no reason to stop: the next one tries again.
      } finally {
        busy.current = false;
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), EVERY_MS);
    return () => window.clearInterval(timer);
  }, [active, settled, video, videoId, shotIndex, mutateAsync]);

  return { scene, error: check.error };
}
