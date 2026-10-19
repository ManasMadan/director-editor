/**
 * Director live from one connection to the next: the microphone opened (when the browser
 * allows it), the socket to the API's relay, a frame a second of the camera, Director's
 * voice played and its messages handed on, and what the member does on screen told back
 * (a typed line, a move to another shot, a flip of the camera, a take). One connection
 * carries the whole shoot. However it ends, everything it opened is let go.
 *
 * Without a microphone (refused, or none on the device) Director still sees and speaks,
 * and reads what the member types: `onHearing(false)` says so, and nothing ends.
 */
import type { MemoryNote, YourVersion } from "@repo/contracts/api";
import type { ErrorCode } from "@repo/contracts/errors";
import type {
  Facing,
  LiveClientMessage,
  LiveRollState,
  LiveTakeState,
  LiveToolCall,
  LiveToolResult,
  RestorableRow,
} from "@repo/contracts/live";
import { required } from "@repo/contracts/objects";
import { SECOND_MS } from "@repo/contracts/time";
import type { RefObject } from "react";
import { parseServerMessage, type Speaker } from "./live";
import {
  createPlayer,
  liveAudio,
  type Microphone,
  openMicrophone,
  type Player,
} from "./live-audio";
import { logTurnTiming } from "./live-debug";
import { base64Of, captureFrame } from "./media";
import { decodePcm16, encodePcm16, PLAYBACK_RATE } from "./pcm";
import { createVoiceClock, type VoiceClock } from "./voice-clock";

/**
 * Why Director went: the connection dropped without a word, or the API said why (its
 * error code; TIMEOUT is the shoot's time with Director running out).
 */
export type LiveFailure = "dropped" | ErrorCode;

/** The Live API takes a frame a second; the relay drops any sent closer together. */
const FRAME_EVERY_MS = SECOND_MS;
/** A little more than a second, so a frame sent on purpose isn't dropped for jitter. */
const FRAME_GAP_MS = FRAME_EVERY_MS + 150;
const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.6;
/**
 * Past this much waiting to go up the socket (about a frame), a frame is skipped: on a
 * weak uplink the member's voice must not queue behind pictures, and the next frame
 * a second later shows the camera just as well.
 */
const FRAME_BACKLOG_BYTES = 64 * 1024;
/** How long a flipped camera may take to show its first picture before it's sent anyway. */
const NEW_PICTURE_MS = 2 * SECOND_MS;

export interface LiveEvents {
  /** The socket is open: Director can see the member (and hear them, with a microphone). */
  onLive: () => void;
  /**
   * Words from `who`; Director's are heard `delayMs` from now, when its voice reaches
   * them (voice-clock.ts).
   */
  onTranscript: (who: Speaker, text: string, delayMs?: number) => void;
  /** Director finished what it had to say; its voice plays `delayMs` more. */
  onTurn: (delayMs?: number) => void;
  /** The member talked over Director: what it hadn't said yet is dropped. */
  onInterrupted: () => void;
  /** Director asked the shoot screen to do something; answer it with `answer(id, …)`. */
  onTool: (id: string, call: LiveToolCall) => void;
  onSpeaking: (speaking: boolean) => void;
  /** Director can't hear the member any more (the microphone refused or gone). */
  onDeaf: () => void;
  /** Director went, and why. Not when it's let go (`leave`). */
  onEnd: (failure: LiveFailure) => void;
}

interface Session {
  player: Player;
  /** When the voice the player has queued plays, for the captions. */
  clock: VoiceClock;
  /** Director's voice is held (a take is recording): nothing queues. */
  held: boolean;
  microphone: Microphone | null;
  /** The socket, once it's open. */
  live: WebSocket | null;
  frames: number;
  /** When the last frame went up (performance.now), so one sent on purpose isn't dropped. */
  lastFrameAt: number;
  /** The shot the member is on, and the one the relay was last told about. */
  shot: number;
  toldShot: number;
  /** What the API said went wrong, just before it closed the socket. */
  error: ErrorCode | null;
  over: boolean;
  /** The roll is paused: Director neither sees nor hears the member until it resumes. */
  muted: boolean;
}

function send(socket: WebSocket, message: LiveClientMessage) {
  socket.send(JSON.stringify(message));
}

/** Tells the relay which shot the member is on, if it doesn't know yet. */
function tellShot(session: Session) {
  if (session.live && session.shot !== session.toldShot) {
    send(session.live, { type: "shot", shot: session.shot });
    session.toldShot = session.shot;
  }
}

function stopFrames(session: Session) {
  window.clearInterval(session.frames);
  session.frames = 0;
}

function hangUp(session: Session, socket: WebSocket | null) {
  session.over = true;
  session.live = null;
  stopFrames(session);
  session.microphone?.stop();
  session.player.close();
  socket?.close();
}

/** What the camera shows now, to Director, as JPEG. */
async function sendFrame(
  session: Session,
  socket: WebSocket,
  video: RefObject<HTMLVideoElement | null>,
) {
  if (session.muted || socket.bufferedAmount > FRAME_BACKLOG_BYTES) {
    return;
  }
  try {
    const camera = required(video.current, "the camera");
    const frame = await captureFrame(camera, FRAME_WIDTH, FRAME_QUALITY);
    send(socket, { type: "frame", jpeg: await base64Of(frame) });
    session.lastFrameAt = performance.now();
  } catch {
    // No picture to give (the camera flipping or reopening): this second's frame is
    // skipped, and the next one goes in its place.
    return;
  }
}

function startFrames(
  session: Session,
  socket: WebSocket,
  video: RefObject<HTMLVideoElement | null>,
) {
  stopFrames(session);
  session.frames = window.setInterval(() => void sendFrame(session, socket, video), FRAME_EVERY_MS);
}

/** Resolves once the camera's <video> has a picture of its own stream, or a while has passed. */
export function picture(video: HTMLVideoElement | null) {
  return new Promise<void>((resolve) => {
    if (!video || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return resolve();
    }
    const timer = window.setTimeout(resolve, NEW_PICTURE_MS);
    video.addEventListener(
      "loadeddata",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, ms)));

/**
 * The member flipped the camera: once the new camera shows a picture, it goes to Director
 * (the regular frames wait, so the relay doesn't drop it for coming too soon), then the
 * note that the camera flipped, so Director talks about what it sees now.
 */
async function noteCamera(
  session: Session,
  video: RefObject<HTMLVideoElement | null>,
  facing: Facing,
) {
  const socket = session.live;
  if (!socket) {
    return;
  }
  stopFrames(session);
  await picture(video.current);
  await pause(session.lastFrameAt + FRAME_GAP_MS - performance.now());
  if (session.live !== socket) {
    return;
  }
  await sendFrame(session, socket, video);
  send(socket, { type: "camera", facing });
  startFrames(session, socket, video);
}

/** Director's voice held (dropped unplayed) or let through: what's queued goes. */
function hold(session: Session, on: boolean) {
  session.held = on;
  session.player.hold(on);
  if (on) {
    session.clock.flushed();
  }
}

/** A chunk of Director's voice, queued to play, and its place on the voice's clock. */
function play(session: Session, pcm: Int16Array) {
  session.player.play(pcm);
  if (!session.held && pcm.length > 0) {
    session.clock.queued(pcm.length / PLAYBACK_RATE);
  }
}

/**
 * Director's turn is over: its line ends once its voice has played, and the turn's
 * timing goes to the debug log (live-debug.ts).
 */
function turnOver(session: Session, events: LiveEvents) {
  const left = session.clock.leftMs();
  logTurnTiming(session.clock.turnOver(), performance.now());
  events.onTurn(left);
}

function receive(session: Session, data: unknown, events: LiveEvents) {
  const message = parseServerMessage(data);
  switch (message?.type) {
    case "audio":
      return play(session, decodePcm16(message.pcm16));
    case "transcript":
      return message.who === "director"
        ? events.onTranscript("director", message.text, session.clock.wait(message.text))
        : events.onTranscript("you", message.text);
    case "tool":
      return events.onTool(message.id, message.call);
    // The member talked over Director: what it was still to say is dropped (barge-in).
    case "interrupted":
      session.player.flush();
      session.clock.flushed();
      return events.onInterrupted();
    case "turn":
      return turnOver(session, events);
    case "error":
      session.error = message.code;
      return;
  }
}

interface Target {
  url: string;
  video: RefObject<HTMLVideoElement | null>;
  events: LiveEvents;
  /** The member's version so far (memory, changed shots, skips): a fresh connection hears it first. */
  version: () => YourVersion;
}

function connect(
  session: Session,
  { url, video, events, version }: Target,
  finish: (failure: LiveFailure) => void,
) {
  const socket = new WebSocket(url);
  socket.onopen = () => {
    session.live = socket;
    events.onLive();
    send(socket, { type: "context", version: version() });
    tellShot(session);
    listen(session);
    startFrames(session, socket, video);
  };
  socket.onmessage = (event: MessageEvent<unknown>) => receive(session, event.data, events);
  // The API says why before it hangs up; a close without a word is a dropped line.
  socket.onclose = () => finish(session.error ?? "dropped");
  return socket;
}

/** The member's microphone goes up the line, once both are there, whichever came first. */
function listen(session: Session) {
  session.microphone?.listen((pcm) => {
    if (session.live && !session.muted) {
      send(session.live, { type: "audio", pcm16: encodePcm16(pcm) });
    }
  });
}

/** The roll (the continuous recording), told to the relay while it's there. */
function rollControls(session: Session, whenLive: (act: (live: WebSocket) => void) => void) {
  return {
    /** Where the roll is. */
    roll: (state: LiveRollState) => whenLive((live) => send(live, { type: "roll", state })),
    /** Paused: nothing of the member goes to Director (their microphone, their camera). */
    mute: (on: boolean) => {
      session.muted = on;
    },
  };
}

/** What the member changed in their version, told to the relay while it's there. */
function versionControls(whenLive: (act: (live: WebSocket) => void) => void) {
  return {
    /** The member's version changed: Director is briefed with it from now on. */
    share: (version: YourVersion) => whenLive((live) => send(live, { type: "context", version })),
    /** The member took a chip away: Director lets it go. */
    forgot: (note: MemoryNote) => whenLive((live) => send(live, { type: "forgot", ...note })),
    /** The member put a row of the card back to the original's. */
    restored: (shot: number, row: RestorableRow) =>
      whenLive((live) => send(live, { type: "restored", shot, row })),
  };
}

/**
 * Starts Director live at `url`, on shot `shot`. Run it from the member's tap the first
 * time: the audio is woken before anything is awaited, while the browser still counts
 * the tap as permission to make sound. `held` starts with Director's voice held (a take
 * is recording).
 */
export function startSession(target: Target & { shot: number; held: boolean }) {
  const context = liveAudio();
  const session: Session = {
    player: createPlayer(context, target.events.onSpeaking),
    clock: createVoiceClock(() => context.currentTime),
    held: target.held,
    microphone: null,
    live: null,
    frames: 0,
    lastFrameAt: Number.NEGATIVE_INFINITY,
    shot: target.shot,
    toldShot: target.shot,
    error: null,
    over: false,
    muted: false,
  };
  session.player.hold(target.held);
  let socket: WebSocket | null = null;
  const finish = (failure: LiveFailure) => {
    if (!session.over) {
      hangUp(session, socket);
      target.events.onEnd(failure);
    }
  };
  const deaf = () => {
    session.microphone?.stop();
    session.microphone = null;
    target.events.onDeaf();
  };
  // The line to Director opens at once, beside the permission prompt: waiting for the
  // microphone first put the whole prompt in front of Director's first word.
  socket = connect(session, target, finish);
  const heard = (microphone: Microphone) => {
    // Left while the browser was still asking for the microphone.
    if (session.over) {
      return microphone.stop();
    }
    session.microphone = microphone;
    listen(session);
  };
  openMicrophone(context, deaf).then(heard, () => target.events.onDeaf());
  const whenLive = (act: (live: WebSocket) => void) => {
    if (session.live) {
      act(session.live);
    }
  };
  return {
    /** Goes quietly: the screen is going away. */
    leave: () => hangUp(session, socket),
    /** The member is on shot `index` now: Director directs that one. */
    moveTo: (index: number) => {
      session.shot = index;
      tellShot(session);
    },
    hold: (on: boolean) => hold(session, on),
    /** How loud Director is right now, from 0 to 1. */
    level: () => session.player.level(),
    /** A typed line for Director; false while there's no one to hear it yet. */
    say: (text: string) => {
      whenLive((live) => send(live, { type: "text", text }));
      return session.live !== null;
    },
    /** What came of a tool call Director made. */
    answer: (id: string, result: LiveToolResult) =>
      whenLive((live) => send(live, { type: "tool_result", id, result })),
    /** The member flipped the camera to `facing`; resolves once Director's been told. */
    camera: (facing: Facing) => noteCamera(session, target.video, facing),
    /** Where the member's take is. */
    take: (state: LiveTakeState) => whenLive((live) => send(live, { type: "take", state })),
    ...rollControls(session, whenLive),
    ...versionControls(whenLive),
  };
}

export type LiveControls = ReturnType<typeof startSession>;
