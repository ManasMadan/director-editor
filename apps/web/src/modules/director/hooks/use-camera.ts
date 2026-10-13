"use client";

import type { Shot } from "@repo/contracts/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { openCamera, openScreen, stopStream } from "../lib/media";

export type CameraState = "starting" | "live" | "blocked" | "missing";
export type Source = "camera" | "screen";

/** Showing Director the screen: `share` is null where the browser can't share one. */
function useScreenShare(
  use: (opened: MediaStream) => boolean,
  backToCamera: () => Promise<void>,
  setSource: (source: Source) => void,
) {
  const [failed, setFailed] = useState(false);
  const share = useCallback(async () => {
    setFailed(false);
    try {
      const screen = await openScreen();
      if (use(screen)) {
        setSource("screen");
        // The browser's own "Stop sharing" ends the track: back to the camera.
        screen.getVideoTracks()[0]?.addEventListener("ended", () => void backToCamera());
      }
    } catch (error) {
      // Cancelling the browser's picker is a choice, not a failure.
      const cancelled = error instanceof DOMException && error.name === "NotAllowedError";
      setFailed(!cancelled);
    }
  }, [use, backToCamera, setSource]);
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  return { share: supported ? share : null, failed };
}

/**
 * The shot's camera on the viewfinder's <video>, opened on mount and closed on unmount,
 * including when the screen goes away while the browser is still asking for permission:
 * a stream that arrives after that is stopped at once, so the camera and microphone
 * never stay on.
 *
 * The member can flip to the other camera (someone else filming them, say) and show
 * Director their screen instead; ending the share from the browser's own bar brings the
 * camera back.
 */
export function useCamera(camera: Shot["camera"], withSound: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(false);
  const [facing, setFacing] = useState<Shot["camera"]>(camera);
  const [source, setSource] = useState<Source>("camera");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("starting");

  const use = useCallback((opened: MediaStream) => {
    if (!mounted.current) {
      stopStream(opened);
      return false;
    }
    stopStream(current.current);
    current.current = opened;
    setStream(opened);
    setState("live");
    return true;
  }, []);

  const start = useCallback(async () => {
    setState("starting");
    try {
      if (use(await openCamera(facing, withSound))) {
        setSource("camera");
      }
    } catch (error) {
      if (mounted.current) {
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        setState(denied ? "blocked" : "missing");
      }
    }
  }, [facing, withSound, use]);

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

  const screen = useScreenShare(use, start, setSource);
  return {
    video,
    stream,
    state,
    start,
    /** Which way the camera faces now (the shot's, until the member flips it). */
    facing,
    flip: () => setFacing((now) => (now === "front" ? "back" : "front")),
    source,
    share: screen.share,
    stopSharing: () => void start(),
    shareFailed: screen.failed,
  };
}
