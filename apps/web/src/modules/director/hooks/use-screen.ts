"use client";

import { useEffect } from "react";
import { wakeLiveAudio } from "../lib/live-audio";
import { keepScreenOn } from "../lib/wake-lock";

/** Keeps the screen on while the shoot screen is open (lib/wake-lock.ts). */
export function useWakeLock() {
  useEffect(() => keepScreenOn(), []);
}

/**
 * Wakes Director's sound (lib/live-audio.ts) when the member comes back to the shoot
 * screen, and on every touch or key press there: iOS puts it to sleep on a lock, an app
 * switch or a call, and lets it run again only from something the member does.
 */
export function useWakeAudio() {
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") {
        wakeLiveAudio();
      }
    };
    document.addEventListener("visibilitychange", back);
    // The end of a touch and a key press are what let a page start sound again.
    document.addEventListener("pointerup", wakeLiveAudio, true);
    document.addEventListener("keydown", wakeLiveAudio, true);
    return () => {
      document.removeEventListener("visibilitychange", back);
      document.removeEventListener("pointerup", wakeLiveAudio, true);
      document.removeEventListener("keydown", wakeLiveAudio, true);
    };
  }, []);
}
