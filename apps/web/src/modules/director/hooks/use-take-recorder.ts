"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { recorderFormat, VIDEO_BITS_PER_SECOND } from "../lib/media";

/** The longest a take may run (the take upload's size allows a minute at our bitrate). */
const MAX_SECONDS = 60;
/** How often the clock (the teleprompter, the steps) moves on: smooth enough, and it keeps
 * the whole camera screen from re-rendering every frame while the recorder runs. */
const TICK_MS = 100;

/** Records the camera into a take; `seconds` counts up while it runs. */
export function useTakeRecorder(stream: MediaStream | null) {
  const recorder = useRef<MediaRecorder | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [take, setTake] = useState<Blob | null>(null);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
    }
  }, []);

  /** Starts recording; false when this browser can't record this camera. */
  const start = useCallback((): boolean => {
    const format = typeof MediaRecorder === "undefined" ? null : recorderFormat();
    if (!stream || !format) {
      return false;
    }
    const chunks: Blob[] = [];
    let next: MediaRecorder;
    try {
      next = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
    } catch {
      return false;
    }
    next.ondataavailable = (event) => chunks.push(event.data);
    next.onstop = () => {
      setRecording(false);
      setTake(new Blob(chunks, { type: format.uploadType }));
    };
    recorder.current = next;
    setTake(null);
    setSeconds(0);
    next.start(500);
    setRecording(true);
    return true;
  }, [stream]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    const begun = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - begun) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) {
        stop();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [recording, stop]);

  // Leaving mid-take stops the recorder with the screen.
  useEffect(() => stop, [stop]);

  return { start, stop, recording, seconds, take, discard: () => setTake(null) };
}
