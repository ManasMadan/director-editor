"use client";

import type { LiveTool } from "@repo/contracts/live";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CallControls, type CallFailure, startCall } from "../lib/call-session";
import { type Captions, callUrl, NO_CAPTIONS, withTranscript } from "../lib/live-call";

export type { CallFailure } from "../lib/call-session";
export type CallState = "idle" | "connecting" | "live" | "ended" | "failed";

/**
 * Tells the call each move to another shot, and hangs up when the screen goes away. When
 * the screen is only remounted (Strict Mode's second mount in development, Fast Refresh)
 * it comes back idle, so the call can start again.
 */
function useCallLifetime(
  call: RefObject<CallControls | null>,
  shotIndex: number,
  setState: (state: CallState) => void,
) {
  useEffect(() => {
    call.current?.moveTo(shotIndex);
  }, [call, shotIndex]);
  useEffect(
    () => () => {
      if (call.current) {
        call.current.leave();
        call.current = null;
        setState("idle");
      }
    },
    [call, setState],
  );
}

/**
 * A voice and video call with Director (Gemini Live, through the API's relay) about a
 * short: the microphone and a frame a second of the camera (`video`) go up; Director's
 * voice, both sides' captions and its tool calls (`onTool`: record, stop, retake, next or
 * previous shot) come back. One call lasts across the shots: when `shotIndex` changes the
 * relay is told, and Director moves on with everything said so far. `start` must run from
 * the member's tap the first time, so the browser lets the page make sound.
 *
 * `end` hangs up ("ended"); the call's time limit ends it too. A refused microphone, a
 * dropped connection or an error from the API fails it ("failed"). `onEnd` hears which,
 * and why. Leaving the screen hangs up quietly, and a screen that comes back (React's
 * Strict Mode, Fast Refresh) finds the hook idle, ready to call again.
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
  const held = useRef(false);
  const latest = useRef({ events, shotIndex });
  useLayoutEffect(() => {
    latest.current = { events, shotIndex };
  });

  const ended = useCallback((failure: CallFailure | null) => {
    call.current = null;
    // The time limit is how a call ends, not a fault: the member just calls again.
    setState(failure === null || failure === "TIMEOUT" ? "ended" : "failed");
    latest.current.events.onEnd(failure);
  }, []);

  const start = useCallback(() => {
    if (call.current) {
      return;
    }
    setState("connecting");
    setCaptions(NO_CAPTIONS);
    setMuted(false);
    const shot = latest.current.shotIndex;
    call.current = startCall({
      url: callUrl(window.location, videoId, shot),
      shot,
      held: held.current,
      video,
      events: {
        onLive: () => setState("live"),
        onTranscript: (who, text) => setCaptions((now) => withTranscript(now, who, text)),
        onTool: (name) => latest.current.events.onTool(name),
        onSpeaking: setSpeaking,
        onEnd: ended,
      },
    });
  }, [videoId, video, ended]);

  useCallLifetime(call, shotIndex, setState);

  return {
    state,
    start,
    /** Hangs up; on a call that's already over, it just puts the hook back to "ended". */
    end: () => {
      if (!call.current?.end()) {
        ended(null);
      }
    },
    muted,
    // Only an open microphone can be muted: the button waits for the call to be live.
    toggleMute: () => {
      if (call.current?.mute(!muted)) {
        setMuted(!muted);
      }
    },
    /** Holds Director's voice (drops it unplayed) while a take records the member's. */
    hold: useCallback((on: boolean) => {
      held.current = on;
      call.current?.hold(on);
    }, []),
    /** Whether Director's voice is playing. */
    speaking,
    captions,
    /** How loud Director is right now, from 0 to 1 (read every frame by the orb). */
    level: useCallback(() => call.current?.level() ?? 0, []),
  };
}
