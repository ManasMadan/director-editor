"use client";

import { SECOND_MS } from "@repo/contracts/time";
import { useEffect, useState } from "react";

/** How long without a touch before the controls step back. */
const IDLE_MS = 3.5 * SECOND_MS;

/**
 * Whether the member has left the screen alone for a while, so the controls can fade and
 * the picture take over; any touch, move or key brings them straight back.
 */
export function useIdle(enabled: boolean) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const events = ["pointerdown", "pointermove", "keydown"] as const;
    for (const event of events) {
      window.addEventListener(event, wake, { passive: true });
    }
    return () => {
      window.clearTimeout(timer);
      for (const event of events) {
        window.removeEventListener(event, wake);
      }
    };
  }, [enabled]);
  return idle;
}

/**
 * Keeps the screen on while the camera screen is open: a phone propped across the room
 * shouldn't lock mid-setup. The browser drops the lock when the page is hidden, so it's
 * taken again on return. Where there's no Wake Lock API, the screen behaves as usual.
 */
export function useWakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let released = false;
    const take = () => {
      if (document.visibilityState !== "visible" || released) {
        return;
      }
      navigator.wakeLock
        .request("screen")
        .then((sentinel) => {
          lock = sentinel;
        })
        .catch(() => {
          // Refused (battery saver, no permission): the screen just locks as it would.
          lock = null;
        });
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, []);
}

/** A short buzz on phones that can (Android): a beat felt as well as seen. */
export function buzz(pattern: number | number[]) {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
