"use client";

import type { Facing } from "@repo/contracts/live";
import { useCallback, useEffect, useRef, useState } from "react";
import { openCamera, stopStream } from "../lib/media";

export type CameraState = "off" | "starting" | "live" | "blocked" | "missing";

/**
 * The shoot's camera on the viewfinder's <video>: off until `start` (the member's "Start
 * shooting" tap, so the browser's permission prompt never comes cold), then the front
 * camera, the selfie side, until the member flips it. It stays open across every shot of
 * the shoot, and is closed when the screen goes, including when it goes while the browser
 * is still asking for permission: a stream that arrives after that is stopped at once,
 * so the camera and microphone never stay on.
 */
export function useCamera(withSound: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>("front");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("off");
  // Bumped by each `start`: "Try again" after a refusal opens the camera once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt === 0) {
      return;
    }
    let active = true;
    setState("starting");
    openCamera(facing, withSound).then(
      (opened) => {
        if (!active) {
          return stopStream(opened);
        }
        stopStream(current.current);
        current.current = opened;
        setStream(opened);
        setState("live");
      },
      (error: unknown) => {
        if (active) {
          const denied = error instanceof DOMException && error.name === "NotAllowedError";
          setState(denied ? "blocked" : "missing");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, facing, withSound]);

  // Closed with the screen.
  useEffect(
    () => () => {
      stopStream(current.current);
      current.current = null;
    },
    [],
  );

  useEffect(() => {
    if (video.current) {
      video.current.srcObject = stream;
    }
  }, [stream]);

  return {
    video,
    stream,
    state,
    /** Opens the camera, or tries again after it was refused. */
    start: useCallback(() => setAttempt((now) => now + 1), []),
    /** Which way the camera faces now: the front, until the member (or Director) flips it. */
    facing,
    flip: () => setFacing((now) => (now === "front" ? "back" : "front")),
    face: setFacing,
  };
}
