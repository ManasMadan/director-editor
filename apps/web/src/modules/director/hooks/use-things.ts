"use client";

import { type RefObject, useEffect, useState } from "react";
import { createThingDetector } from "../lib/object-detector";
import { held, highlights, type Seen } from "../lib/things";

/** Five looks a second: highlights follow a moving phone, and leave room for the pose model. */
const EVERY_MS = 200;

/**
 * The things worth pointing out in the frame (lib/things.ts), found on the device while
 * `enabled`. A detector that can't load (an old phone, no GPU) leaves the list empty: the
 * highlights are a bonus, never something the screen waits for.
 */
export function useThings(
  video: RefObject<HTMLVideoElement | null>,
  { enabled, landmark }: { enabled: boolean; landmark: string | null },
) {
  const [things, setThings] = useState<Seen[]>([]);

  useEffect(() => {
    if (!enabled) {
      setThings([]);
      return;
    }
    let stopped = false;
    let frame = 0;
    let close: (() => void) | null = null;
    createThingDetector()
      .then((detector) => {
        close = () => detector.close();
        if (stopped) {
          detector.close();
          return;
        }
        let last = 0;
        let kept: ReturnType<typeof held> = [];
        const tick = (now: number) => {
          const element = video.current;
          if (element && element.readyState >= 2 && now - last >= EVERY_MS) {
            last = now;
            kept = held(kept, detector.detect(element, now), now / 1000);
            setThings(highlights(kept, landmark));
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch(() => setThings([]));
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      close?.();
    };
  }, [enabled, landmark, video]);

  return things;
}
