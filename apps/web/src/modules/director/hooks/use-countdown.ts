"use client";

import { SECOND_MS } from "@repo/contracts/time";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 3, 2, 1, then `onDone`: time to get into position after pressing record. It never shows
 * (or says) zero: the take starts as 1 runs out. `cancel` stops it on any number, and
 * `onDone` never runs then.
 */
export function useCountdown(onDone: () => void, from = 3) {
  const [left, setLeft] = useState<number | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    if (left === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (left > 1) {
        setLeft(left - 1);
        return;
      }
      setLeft(null);
      done.current();
    }, SECOND_MS);
    return () => window.clearTimeout(timer);
  }, [left]);

  return {
    left,
    start: useCallback(() => setLeft(from), [from]),
    cancel: useCallback(() => setLeft(null), []),
  };
}
