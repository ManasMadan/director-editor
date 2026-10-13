"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The editor's clock: plays from where it is to the end of the edit (`total` seconds) and
 * stops there. `clock()` reads it between renders, for what draws every frame.
 */
export function usePlayback(total: number) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const now = useRef(0);

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (at: number) => {
      const next = Math.min(total, now.current + (at - last) / 1000);
      last = at;
      now.current = next;
      setTime(next);
      if (next >= total) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);

  const seek = useCallback(
    (seconds: number) => {
      const next = Math.max(0, Math.min(total, seconds));
      now.current = next;
      setTime(next);
    },
    [total],
  );
  const play = useCallback(() => {
    // From the start again once it has played to the end.
    if (now.current >= total - 0.05) {
      seek(0);
    }
    setPlaying(true);
  }, [seek, total]);
  const pause = useCallback(() => setPlaying(false), []);
  const clock = useCallback(() => now.current, []);
  return { time, playing, play, pause, seek, clock };
}
