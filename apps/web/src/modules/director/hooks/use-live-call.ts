"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CallControls, type CallFailure, startCall } from "../lib/call-session";
import {
  type Captions,
  callUrl,
  type LiveTool,
  NO_CAPTIONS,
  withTranscript,
} from "../lib/live-call";

export type { CallFailure } from "../lib/call-session";
export type CallState = "idle" | "connecting" | "live" | "ended" | "failed";

/**
 * A voice and video call with Director (Gemini Live, through the API's relay) about one
 * shot: the microphone and a frame a second of the camera (`video`) go up; Director's
 * voice, both sides' captions and its tool calls (`onTool`: record, stop, retake, next or
 * previous shot) come back. `start` must run from the member's tap the first time, so the
 * browser lets the page make sound.
 *
 * `end` hangs up ("ended"); a refused microphone, a dropped connection or an error from
 * the API fails the call ("failed"); `onEnd` hears which, and why. Leaving the screen
 * hangs up quietly.
 */
export function useLiveCall({
  videoId,
  shotIndex,
  video,
  ...events
}: {
  videoId: string;
  shotIndex: number;
  video: RefObject<HTMLVideoElement | null>;
  onTool: (name: LiveTool) => void;
  onEnd: (failure: CallFailure | null) => void;
}) {
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [captions, setCaptions] = useState<Captions>(NO_CAPTIONS);
  const call = useRef<CallControls | null>(null);
  const latest = useRef(events);
  useLayoutEffect(() => {
    latest.current = events;
  });

  const start = useCallback(() => {
    if (call.current) {
      return;
    }
    setState("connecting");
    setCaptions(NO_CAPTIONS);
    setMuted(false);
    call.current = startCall({
      url: callUrl(window.location, videoId, shotIndex),
      video,
      events: {
        onLive: () => setState("live"),
        onTranscript: (who, text) => setCaptions((now) => withTranscript(now, who, text)),
        onTool: (name) => latest.current.onTool(name),
        onSpeaking: setSpeaking,
        onEnd: (failure) => {
          call.current = null;
          setState(failure ? "failed" : "ended");
          latest.current.onEnd(failure);
        },
      },
    });
  }, [videoId, shotIndex, video]);

  // Leaving the screen (or the shot) hangs up.
  useEffect(() => () => call.current?.leave(), []);

  return {
    state,
    start,
    end: () => call.current?.end(),
    muted,
    // Only an open microphone can be muted: the button waits for the call to be live.
    toggleMute: () => {
      if (call.current?.mute(!muted)) {
        setMuted(!muted);
      }
    },
    /** Whether Director's voice is playing. */
    speaking,
    captions,
    /** How loud Director is right now, from 0 to 1 (read every frame by the orb). */
    level: useCallback(() => call.current?.level() ?? 0, []),
  };
}
