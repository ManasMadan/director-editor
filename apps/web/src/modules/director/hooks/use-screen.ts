"use client";

import { useEffect } from "react";

/**
 * Keeps the screen on while the shoot screen is open: a phone propped across the room
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
