"use client";

import type { Shot } from "@repo/contracts/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { openCamera, stopStream } from "../lib/media";

export type CameraState = "starting" | "live" | "blocked" | "missing";

/**
 * The shot's camera on a <video>, opened on mount and closed on unmount, including when
 * the screen goes away while the browser is still asking for permission: a stream that
 * arrives after that is stopped at once, so the camera and microphone never stay on.
 */
export function useCamera(camera: Shot["camera"], withSound: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("starting");

  const start = useCallback(async () => {
    setState("starting");
    try {
      const opened = await openCamera(camera, withSound);
      if (!mounted.current) {
        stopStream(opened);
        return;
      }
      stopStream(current.current);
      current.current = opened;
      setStream(opened);
      setState("live");
    } catch (error) {
      if (mounted.current) {
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        setState(denied ? "blocked" : "missing");
      }
    }
  }, [camera, withSound]);

  useEffect(() => {
    mounted.current = true;
    void start();
    return () => {
      mounted.current = false;
      stopStream(current.current);
      current.current = null;
    };
  }, [start]);

  useEffect(() => {
    if (video.current) {
      video.current.srcObject = stream;
    }
  }, [stream]);

  return { video, stream, state, start };
}
