"use client";

import type {
  Facing,
  LiveAdaptation,
  LiveRollState,
  LiveTakeState,
  LiveToolCall,
  LiveToolResult,
} from "@repo/contracts/live";
import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  answered,
  type Captions,
  liveUrl,
  NO_CAPTIONS,
  turnEnded,
  withoutMember,
  withTranscript,
  withTyped,
} from "../lib/live";
import { restLiveAudio } from "../lib/live-audio";
import { type LiveControls, type LiveFailure, startSession } from "../lib/live-session";

export type { LiveFailure } from "../lib/live-session";
/**
 * Where Director is: not asked yet (before "Start shooting"), joining, with the member,
 * or unavailable (`failure` says why), when the member can still film with the shutter.
 */
export type LiveState = "idle" | "joining" | "live" | "unavailable";

/** Failures that may pass: one silent retry, a moment later, before the member is told. */
const PASSING: readonly LiveFailure[] = ["dropped", "UPSTREAM_UNAVAILABLE", "INTERNAL"];
const RETRY_AFTER_MS = 2 * SECOND_MS;
/** How long the member's line stays up once Director has answered it. */
const ANSWERED_FOR_MS = 8 * SECOND_MS;
/** Where a take is when the member's last line has been overtaken by what they did. */
const OVERTAKING: readonly LiveTakeState[] = ["countdown", "recorded"];

interface Options {
  videoId: string;
  shotIndex: number;
  video: RefObject<HTMLVideoElement | null>;
  /** Director asked for something; answer with `answer(id, result)`. */
  onTool: (id: string, call: LiveToolCall) => void;
  /** What Director changed in the shots so far, for a fresh connection to know. */
  adaptations: LiveAdaptation[];
}

/** What the session hears, kept in the hook's state. */
function useSessionState() {
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(true);
  const [captions, setCaptions] = useState<Captions>(NO_CAPTIONS);
  return {
    state,
    setState,
    failure,
    setFailure,
    speaking,
    setSpeaking,
    hearing,
    setHearing,
    captions,
    setCaptions,
  };
}

/**
 * Tells Director each move to another shot, and lets it go when the screen goes. When
 * the screen is only remounted (Strict Mode's second mount in development, Fast Refresh)
 * it comes back idle, so Director joins again by itself.
 */
function useLifetime(
  session: RefObject<LiveControls | null>,
  shotIndex: number,
  { setState, retry }: { setState: (state: LiveState) => void; retry: RefObject<number> },
) {
  useEffect(() => {
    session.current?.moveTo(shotIndex);
  }, [session, shotIndex]);
  useEffect(
    () => () => {
      window.clearTimeout(retry.current);
      if (session.current) {
        session.current.leave();
        session.current = null;
        setState("idle");
      }
    },
    [session, setState, retry],
  );
  useEffect(() => restLiveAudio, []);
}

interface Refs {
  videoId: string;
  video: RefObject<HTMLVideoElement | null>;
  session: RefObject<LiveControls | null>;
  held: RefObject<boolean>;
  retry: RefObject<number>;
  retried: RefObject<boolean>;
  latest: RefObject<Pick<Options, "onTool" | "shotIndex" | "adaptations">>;
}

type Setters = Pick<
  ReturnType<typeof useSessionState>,
  "setState" | "setFailure" | "setCaptions" | "setSpeaking" | "setHearing"
>;

/**
 * Opens a connection (unless one is open): `resume` when Director was here a moment ago,
 * so it carries on rather than saying hello again. A failure that may pass is retried
 * once, silently.
 */
function useConnect(refs: Refs, setters: Setters) {
  const { videoId, video, session, held, retry, retried, latest } = refs;
  const { setState, setFailure, setCaptions, setSpeaking, setHearing } = setters;
  const connect = useCallback(
    (resume: boolean) => {
      if (session.current) {
        return;
      }
      setState("joining");
      const shot = latest.current.shotIndex;
      session.current = startSession({
        url: liveUrl(window.location, videoId, shot, resume),
        shot,
        held: held.current,
        video,
        adaptations: () => latest.current.adaptations,
        events: {
          onLive: () => {
            retried.current = false;
            setState("live");
          },
          onTranscript: (who, text) => {
            // Words said while its voice is held were never heard: they aren't shown either.
            if (!(who === "director" && held.current)) {
              setCaptions((now) => withTranscript(now, who, text));
            }
          },
          // Director's next words are a new line, not more of this one.
          onTurn: () => setCaptions(turnEnded),
          onTool: (id, call) => latest.current.onTool(id, call),
          onSpeaking: setSpeaking,
          onDeaf: () => setHearing(false),
          onEnd: (failure) => {
            session.current = null;
            if (PASSING.includes(failure) && !retried.current) {
              retried.current = true;
              retry.current = window.setTimeout(() => connect(true), RETRY_AFTER_MS);
              return;
            }
            setFailure(failure);
            setState("unavailable");
          },
        },
      });
    },
    [
      videoId,
      video,
      session,
      held,
      retry,
      retried,
      latest,
      setState,
      setFailure,
      setCaptions,
      setSpeaking,
      setHearing,
    ],
  );
  return connect;
}

/** The screen remounted while Director was wanted: it joins again, picking up the thread. */
function useRejoin(wanted: boolean, state: LiveState, connect: (resume: boolean) => void) {
  useEffect(() => {
    if (wanted && state === "idle") {
      connect(true);
    }
  }, [wanted, state, connect]);
}

/** Where the roll is: Director hears it, and a pause keeps the member from it. */
function rollTo(session: LiveControls | null, state: LiveRollState) {
  session?.mute(state === "paused");
  session?.roll(state);
}

/** The member's line goes a while after Director has answered it. */
function useAnsweredLineFades(captions: Captions, setCaptions: Setters["setCaptions"]) {
  const done = answered(captions);
  useEffect(() => {
    if (!done) {
      return;
    }
    const timer = window.setTimeout(() => setCaptions(withoutMember), ANSWERED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [done, setCaptions]);
}

/**
 * Director live on the shoot screen (Gemini Live, through the API's relay): the
 * microphone and a frame a second of the camera (`video`) go up; Director's voice, both
 * sides' captions and its tool calls come back. One connection lasts the whole shoot:
 * when `shotIndex` changes the relay is told, and Director moves on with everything said
 * so far. `start` must run from the member's tap the first time, so the browser lets the
 * page make sound.
 *
 * A dropped connection or Gemini being out of reach is retried once, silently, two
 * seconds later; if that fails too (or for anything else, like the hour's allowance being
 * spent) Director is "unavailable" with the reason, until the member taps to try again.
 */
export function useDirectorLive({ videoId, shotIndex, video, onTool, adaptations }: Options) {
  const live = useSessionState();
  const [wanted, setWanted] = useState(false);
  const session = useRef<LiveControls | null>(null);
  const held = useRef(false);
  const retry = useRef(0);
  const retried = useRef(false);
  const latest = useRef({ onTool, shotIndex, adaptations });
  useLayoutEffect(() => {
    latest.current = { onTool, shotIndex, adaptations };
  });
  const { setState, setFailure, setCaptions, setSpeaking, setHearing } = live;

  const connect = useConnect(
    { videoId, video, session, held, retry, retried, latest },
    { setState, setFailure, setCaptions, setSpeaking, setHearing },
  );

  useRejoin(wanted, live.state, connect);
  useLifetime(session, shotIndex, { setState, retry });
  useAnsweredLineFades(live.captions, setCaptions);

  return {
    state: live.state,
    failure: live.failure,
    /** Whether Director can hear the member (a microphone was allowed and is still there). */
    hearing: live.hearing,
    /** Director joins: from the "Start shooting" tap, or "Try again" after it couldn't. */
    start: () => {
      window.clearTimeout(retry.current);
      retried.current = false;
      setFailure(null);
      setHearing(true);
      setCaptions(NO_CAPTIONS);
      setWanted(true);
      connect(false);
    },
    /** A typed line, shown as the member's own; false when Director isn't there to read it. */
    say: (text: string) => {
      const sent = session.current?.say(text) ?? false;
      if (sent) {
        setCaptions((now) => withTyped(now, text));
      }
      return sent;
    },
    answer: (id: string, result: LiveToolResult) => session.current?.answer(id, result),
    /** The member flipped the camera: Director looks at the new view. */
    camera: (facing: Facing) => {
      setCaptions(withoutMember);
      void session.current?.camera(facing);
    },
    roll: (state: LiveRollState) => rollTo(session.current, state),
    /** Where the member's take is; from a countdown on, their last line has had its moment. */
    take: (state: LiveTakeState) => {
      if (OVERTAKING.includes(state)) {
        setCaptions(withoutMember);
      }
      session.current?.take(state);
    },
    /** Holds Director's voice (drops it unplayed, uncaptioned) from the 3-2-1 to the take's end. */
    hold: useCallback((on: boolean) => {
      held.current = on;
      session.current?.hold(on);
    }, []),
    /** Whether Director's voice is playing. */
    speaking: live.speaking,
    captions: live.captions,
    /** How loud Director is right now, from 0 to 1 (read every frame by the orb). */
    level: useCallback(() => session.current?.level() ?? 0, []),
  };
}

export type DirectorLive = ReturnType<typeof useDirectorLive>;
