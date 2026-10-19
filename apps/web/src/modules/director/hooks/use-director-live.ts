"use client";

import { useDirectorChatMutation } from "@repo/client/api/director/chat";
import { useSpeakMutation } from "@repo/client/api/director/speak";
import type { MemoryNote, YourVersion } from "@repo/contracts/api";
import type { ErrorCode } from "@repo/contracts/errors";
import type {
  Facing,
  LiveRollState,
  LiveTakeState,
  LiveToolCall,
  LiveToolResult,
  RestorableRow,
} from "@repo/contracts/live";
import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CaptionStore, createCaptionStore, type Working } from "../lib/caption-store";
import { liveUrl } from "../lib/live";
import { prepareLiveAudio, restLiveAudio } from "../lib/live-audio";
import {
  type LiveControls,
  type LiveEvents,
  type LiveFailure,
  startSession,
} from "../lib/live-session";
import { type SlowLineApi, type SlowTarget, startSlowSession } from "../lib/slow-session";

export type { LiveFailure } from "../lib/live-session";
/**
 * Where Director is: not asked yet (before "Start shooting"), joining, with the member,
 * or unavailable (`failure` says why), when the member can still film with the shutter.
 */
export type LiveState = "idle" | "joining" | "live" | "unavailable";
/**
 * Which line Director is on: Gemini Live, or the slower line (Gemini Flash turn by turn,
 * spoken with Gemini's text-to-speech) once Live couldn't start or dropped twice.
 */
type LiveLine = "live" | "slower";

/** Failures that may pass: one silent retry, a moment later, before the member is told. */
const PASSING: readonly LiveFailure[] = ["dropped", "UPSTREAM_UNAVAILABLE", "INTERNAL"];
const RETRY_AFTER_MS = 2 * SECOND_MS;
/** When the audio context is made ahead of the tap (`prepareLiveAudio`, lib/live-audio.ts). */
const PREPARE_AUDIO_AFTER_MS = SECOND_MS;
/** Where a take is when the member's last line has been overtaken by what they did. */
const OVERTAKING: readonly LiveTakeState[] = ["countdown", "recorded"];
/**
 * Why Live couldn't be had that the slower line can't fix either: the member, the plan or
 * another tab. Anything else (Live off for them, out of reach, its allowance spent, its
 * time up) moves Director to the slower line.
 */
const NO_SLOWER_LINE: readonly LiveFailure[] = [
  "UNAUTHENTICATED",
  "NO_ACTIVE_ORGANIZATION",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_SHOT_NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
] satisfies ErrorCode[];

interface Options {
  videoId: string;
  shotIndex: number;
  video: RefObject<HTMLVideoElement | null>;
  /** Director asked for something; answer with `answer(id, result)`. */
  onTool: (id: string, call: LiveToolCall) => void;
  /** The member's version so far, for a fresh connection (or the slower line) to know. */
  version: YourVersion;
  /** The member said or typed something (the screen reads it: did they ask to move on?). */
  onMemberSaid?: (text: string) => void;
}

/** What the session hears, kept in the hook's state. */
function useSessionState() {
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(true);
  // The captions keep their own store: a transcript chunk re-renders them, not the screen.
  const [captions] = useState(createCaptionStore);
  const [line, setLine] = useState<LiveLine>("live");
  const [away, setAway] = useState(false);
  return {
    line,
    setLine,
    away,
    setAway,
    state,
    setState,
    failure,
    setFailure,
    speaking,
    setSpeaking,
    hearing,
    setHearing,
    captions,
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
  // A moment after the screen opens, once it has drawn: not in the "Start shooting" tap.
  useEffect(() => {
    const timer = window.setTimeout(prepareLiveAudio, PREPARE_AUDIO_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
}

interface Refs {
  videoId: string;
  video: RefObject<HTMLVideoElement | null>;
  session: RefObject<LiveControls | null>;
  held: RefObject<boolean>;
  retry: RefObject<number>;
  retried: RefObject<boolean>;
  captions: CaptionStore;
  latest: RefObject<
    Pick<Options, "onTool" | "shotIndex" | "version" | "onMemberSaid"> & { api: SlowLineApi }
  >;
}

type Setters = Pick<
  ReturnType<typeof useSessionState>,
  "setState" | "setFailure" | "setSpeaking" | "setHearing" | "setLine" | "setAway"
>;

/**
 * What either line says goes to the captions. Words said while Director's voice is held
 * were never heard: they aren't shown either. The member's words also go to the screen,
 * which listens for them asking to move on.
 */
function captionEvents({
  captions,
  held,
  latest,
}: Pick<Refs, "captions" | "held" | "latest">): Pick<
  LiveEvents,
  "onTranscript" | "onTurn" | "onInterrupted" | "onTool"
> {
  return {
    onTranscript: (who, text, delayMs) => {
      if (who === "you") {
        latest.current.onMemberSaid?.(text);
      }
      if (!(who === "director" && held.current)) {
        captions.said(who, text, delayMs);
      }
    },
    // Director's next words are a new line, not more of this one, once its voice is over.
    onTurn: (delayMs) => captions.turnOver(delayMs),
    onInterrupted: () => captions.cut(),
    onTool: (id, call) => latest.current.onTool(id, call),
  };
}

/**
 * Moves Director to the slower line: the same captions, tools and voice, one turn at a
 * time. It ends only when it can't help either, and Director is then unavailable.
 */
function useSlowerLine(refs: Refs, setters: Setters) {
  const { videoId, video, session, held, latest, captions } = refs;
  const { setState, setFailure, setSpeaking, setHearing, setLine, setAway } = setters;
  return useCallback(() => {
    setLine("slower");
    const events: SlowTarget["events"] = {
      ...captionEvents({ captions, held, latest }),
      onLive: () => setState("live"),
      onSaid: (text) => {
        latest.current.onMemberSaid?.(text);
        captions.typed(text);
      },
      onSpeaking: setSpeaking,
      onDeaf: () => setHearing(false),
      onAway: setAway,
      onEnd: (failure) => {
        session.current = null;
        setAway(false);
        setFailure(failure);
        setState("unavailable");
      },
    };
    session.current = startSlowSession({
      videoId,
      shot: latest.current.shotIndex,
      held: held.current,
      video,
      version: () => latest.current.version,
      // Read when each turn goes, so the mutations are always the hook's current ones.
      api: {
        chat: (input) => latest.current.api.chat(input),
        speak: (input) => latest.current.api.speak(input),
      },
      events,
    });
  }, [
    videoId,
    video,
    session,
    held,
    latest,
    captions,
    setState,
    setFailure,
    setSpeaking,
    setHearing,
    setLine,
    setAway,
  ]);
}

/**
 * Opens a connection (unless one is open): `resume` when Director was here a moment ago,
 * so it carries on rather than saying hello again. A failure that may pass is retried
 * once, silently.
 */
function useConnect(refs: Refs, setters: Setters) {
  const { videoId, video, session, held, retry, retried, latest, captions } = refs;
  const { setState, setFailure, setSpeaking, setHearing, setLine } = setters;
  const slower = useSlowerLine(refs, setters);
  const connect = useCallback(
    (resume: boolean) => {
      if (session.current) {
        return;
      }
      setState("joining");
      setLine("live");
      const shot = latest.current.shotIndex;
      session.current = startSession({
        url: liveUrl(window.location, videoId, shot, resume),
        shot,
        held: held.current,
        video,
        version: () => latest.current.version,
        events: {
          ...captionEvents({ captions, held, latest }),
          onLive: () => {
            retried.current = false;
            setState("live");
          },
          onSpeaking: setSpeaking,
          onDeaf: () => setHearing(false),
          onEnd: (failure) => {
            session.current = null;
            if (PASSING.includes(failure) && !retried.current) {
              retried.current = true;
              retry.current = window.setTimeout(() => connect(true), RETRY_AFTER_MS);
              return;
            }
            if (NO_SLOWER_LINE.includes(failure)) {
              setFailure(failure);
              setState("unavailable");
              return;
            }
            slower();
          },
        },
      });
    },
    [
      slower,
      setLine,
      videoId,
      video,
      session,
      held,
      retry,
      retried,
      latest,
      captions,
      setState,
      setFailure,
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

/** The API calls the slower line makes: a turn, and a line in Director's voice. */
function useSlowLineApi(): SlowLineApi {
  const chat = useDirectorChatMutation();
  const speak = useSpeakMutation();
  return { chat: chat.mutateAsync, speak: speak.mutateAsync };
}

/** What the member changed in their version, for Director to hear on either line. */
function versionOf(session: RefObject<LiveControls | null>) {
  return {
    /** The member's version changed: Director is briefed with it. */
    share: (next: YourVersion) => session.current?.share(next),
    /** The member took a chip away: Director lets it go and says so. */
    forgot: (note: MemoryNote) => session.current?.forgot(note),
    /** The member put a row of the card back to the original's. */
    restored: (shot: number, row: RestorableRow) => session.current?.restored(shot, row),
  };
}

/** What the screen tells whichever line Director is on, with the captions that go with it. */
function sessionControls(
  session: RefObject<LiveControls | null>,
  { captions, latest }: Pick<Refs, "captions" | "latest">,
) {
  return {
    /** A typed line, shown as the member's own; false when Director isn't there to read it. */
    say: (text: string) => {
      const sent = session.current?.say(text) ?? false;
      if (sent) {
        latest.current.onMemberSaid?.(text);
        captions.typed(text);
      }
      return sent;
    },
    answer: (id: string, result: LiveToolResult) => session.current?.answer(id, result),
    /** The member flipped the camera: Director looks at the new view. */
    camera: (facing: Facing) => {
      captions.withoutMember();
      void session.current?.camera(facing);
    },
    roll: (state: LiveRollState) => rollTo(session.current, state),
    /** Where the member's take is; from a countdown on, their last line has had its moment. */
    take: (state: LiveTakeState) => {
      if (OVERTAKING.includes(state)) {
        captions.withoutMember();
      }
      session.current?.take(state);
    },
    /** What Director is busy with that the member can't hear (a re-plan), shown meanwhile. */
    working: (working: Working) => captions.working(working),
  };
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
 * seconds later; if that fails too (or Live is off for the member, or its allowance is
 * spent) Director moves to the slower line, with the same captions and tools, until the
 * member taps Reconnect. Only what neither line can fix (signed out, the plan gone)
 * makes Director "unavailable", with the reason, until the member taps to try again.
 */
export function useDirectorLive({
  videoId,
  shotIndex,
  video,
  onTool,
  version,
  onMemberSaid,
}: Options) {
  const live = useSessionState();
  const [wanted, setWanted] = useState(false);
  const session = useRef<LiveControls | null>(null);
  const held = useRef(false);
  const retry = useRef(0);
  const retried = useRef(false);
  const api = useSlowLineApi();
  const latest = useRef({ onTool, shotIndex, version, onMemberSaid, api });
  useLayoutEffect(() => {
    latest.current = { onTool, shotIndex, version, onMemberSaid, api };
  });
  const { setState, setFailure, setSpeaking, setHearing, setLine, setAway, captions } = live;

  const connect = useConnect(
    { videoId, video, session, held, retry, retried, latest, captions },
    { setState, setFailure, setSpeaking, setHearing, setLine, setAway },
  );

  useRejoin(wanted, live.state, connect);
  useLifetime(session, shotIndex, { setState, retry });
  useEffect(() => () => captions.stop(), [captions]);

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
      captions.clear();
      setAway(false);
      setWanted(true);
      connect(false);
    },
    /** Which line Director is on: Gemini Live, or the slower line. */
    line: live.line,
    /** On the slower line, Gemini is out of reach right now: Director is silent. */
    away: live.away,
    /**
     * Leaves the slower line for Gemini Live again, with what the shoot changed. If Live
     * still can't be had, Director comes straight back on the slower line.
     */
    reconnect: () => {
      session.current?.leave();
      session.current = null;
      setAway(false);
      retried.current = true;
      connect(true);
    },
    ...sessionControls(session, { captions, latest }),
    ...versionOf(session),
    /** Holds Director's voice (drops it unplayed, uncaptioned) from the 3-2-1 to the take's end. */
    hold: useCallback((on: boolean) => {
      held.current = on;
      session.current?.hold(on);
    }, []),
    /** Whether Director's voice is playing. */
    speaking: live.speaking,
    /** The conversation's captions, read only by the captions (`useCaptions`). */
    captions,
    /** How loud Director is right now, from 0 to 1 (read every frame by the orb). */
    level: useCallback(() => session.current?.level() ?? 0, []),
  };
}

export type DirectorLive = ReturnType<typeof useDirectorLive>;
