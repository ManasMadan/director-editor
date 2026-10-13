"use client";

import { useCheckSceneMutation } from "@repo/client/api/director/check-scene";
import type { SceneCheck } from "@repo/contracts/api";
import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { base64Of, captureFrame } from "../lib/media";

/** One frame every few seconds when nothing changes: the API allows 30 checks a minute. */
const EVERY_MS = 6 * SECOND_MS;
/** The soonest a look may follow the last, when the camera moves somewhere new. */
const SOONEST_MS = 2.5 * SECOND_MS;
/** Each check costs the workspace's AI allowance: a camera left on stops asking after this. */
const MOST_CHECKS = 16;
/** Failed checks in a row after which Gemini counts as out of reach for this shot. */
const OFFLINE_AFTER = 2;
const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.7;

/**
 * Gemini's direction to the shot's spot, from what the camera sees, while `active`
 * (before recording starts): every few seconds, and at once when the camera is pointed
 * somewhere new (`moved` changes), so Director reacts as the member moves.
 *
 * When Gemini can't answer (no allowance left, rate-limited, down), the guide says so
 * (`offline`) and stops asking; the camera screen then guides from what the phone sees
 * itself, and nothing breaks. The camera screen is mounted afresh for each shot, so a shot
 * never shows another's check.
 */
export function useSceneGuide(
  video: RefObject<HTMLVideoElement | null>,
  {
    videoId,
    shotIndex,
    active,
    moved,
  }: { videoId: string; shotIndex: number; active: boolean; moved: number },
) {
  const check = useCheckSceneMutation();
  const [scene, setScene] = useState<SceneCheck | null>(null);
  const [offline, setOffline] = useState(false);
  const busy = useRef(false);
  const checks = useRef(0);
  const failures = useRef(0);
  const lastAt = useRef(Number.NEGATIVE_INFINITY);
  // Once Director says you're there, it stops looking.
  const settled = scene?.inPlace === true;
  const { mutateAsync } = check;
  const looking = active && !settled && !offline;

  const look = useCallback(async () => {
    const element = video.current;
    if (busy.current || !element || element.readyState < 2 || document.hidden) {
      return;
    }
    if (checks.current >= MOST_CHECKS) {
      return;
    }
    busy.current = true;
    checks.current += 1;
    lastAt.current = performance.now();
    try {
      const image = await base64Of(await captureFrame(element, FRAME_WIDTH, FRAME_QUALITY));
      setScene(await mutateAsync({ videoId, shotIndex, image }));
      failures.current = 0;
    } catch {
      // One miss is no reason to stop (the next look tries again); a run of them is.
      failures.current += 1;
      setOffline(failures.current >= OFFLINE_AFTER);
    } finally {
      busy.current = false;
    }
  }, [video, videoId, shotIndex, mutateAsync]);

  useEffect(() => {
    if (!looking) {
      return;
    }
    void look();
    const timer = window.setInterval(() => void look(), EVERY_MS);
    return () => window.clearInterval(timer);
  }, [looking, look]);

  // Pointed somewhere new: look now, rather than at the next tick.
  useEffect(() => {
    if (looking && moved > 0 && performance.now() - lastAt.current >= SOONEST_MS) {
      void look();
    }
  }, [looking, moved, look]);

  return { scene, offline };
}
