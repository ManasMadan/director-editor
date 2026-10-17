/**
 * One call with Director, from the tap that starts it to the hang-up: the microphone
 * opened, the socket to the API's relay, a frame a second of the camera, Director's voice
 * played and its messages handed on. However it ends, everything it opened is let go.
 */
import type { ErrorCode } from "@repo/contracts/errors";
import { required } from "@repo/contracts/objects";
import { SECOND_MS } from "@repo/contracts/time";
import type { RefObject } from "react";
import {
  callAudio,
  createPlayer,
  type Microphone,
  openMicrophone,
  type Player,
} from "./call-audio";
import { type LiveTool, parseServerMessage, type Speaker } from "./live-call";
import { base64Of, captureFrame } from "./media";
import { decodePcm16, encodePcm16 } from "./pcm";

/**
 * Why a call failed: the microphone couldn't be opened (or went away), the connection
 * dropped without a word, or the API said why (its error code).
 */
export type CallFailure = "microphone" | "dropped" | ErrorCode;

/** The Live API takes a frame a second; the relay drops any sent closer together. */
const FRAME_EVERY_MS = SECOND_MS;
const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.6;

export interface CallEvents {
  /** The socket is open: Director can hear and see the member. */
  onLive: () => void;
  onTranscript: (who: Speaker, text: string) => void;
  /** Director asked the camera app to do something. */
  onTool: (name: LiveTool) => void;
  onSpeaking: (speaking: boolean) => void;
  /** The call is over: hung up (null), or failed and why. Not when it's left (`leave`). */
  onEnd: (failure: CallFailure | null) => void;
}

interface Call {
  player: Player;
  microphone: Microphone | null;
  socket: WebSocket | null;
  frames: number;
  /** What the API said went wrong, just before it closed the socket. */
  error: ErrorCode | null;
  over: boolean;
}

function hangUp(call: Call) {
  call.over = true;
  window.clearInterval(call.frames);
  call.microphone?.stop();
  call.player.close();
  call.socket?.close();
}

/** What the camera shows now, to Director, as JPEG. */
async function sendFrame(socket: WebSocket, video: RefObject<HTMLVideoElement | null>) {
  try {
    const camera = required(video.current, "the camera");
    const frame = await captureFrame(camera, FRAME_WIDTH, FRAME_QUALITY);
    socket.send(JSON.stringify({ type: "frame", jpeg: await base64Of(frame) }));
  } catch {
    // No picture to give (the camera flipping or reopening): this second's frame is
    // skipped, and the next one goes in its place.
    return;
  }
}

function receive(call: Call, data: unknown, events: CallEvents) {
  const message = parseServerMessage(data);
  switch (message?.type) {
    case "audio":
      return call.player.play(decodePcm16(message.pcm16));
    case "transcript":
      return events.onTranscript(message.who, message.text);
    case "tool":
      return events.onTool(message.name);
    // The member talked over Director: what it was still to say is dropped (barge-in).
    case "interrupted":
      return call.player.flush();
    case "error":
      call.error = message.code;
      return;
  }
}

function connect(
  call: Call,
  microphone: Microphone,
  {
    url,
    video,
    events,
  }: { url: string; video: RefObject<HTMLVideoElement | null>; events: CallEvents },
  finish: (failure: CallFailure | null) => void,
) {
  const socket = new WebSocket(url);
  call.socket = socket;
  socket.onopen = () => {
    events.onLive();
    microphone.listen((pcm) =>
      socket.send(JSON.stringify({ type: "audio", pcm16: encodePcm16(pcm) })),
    );
    call.frames = window.setInterval(() => void sendFrame(socket, video), FRAME_EVERY_MS);
  };
  socket.onmessage = (event: MessageEvent<unknown>) => receive(call, event.data, events);
  // The API says why before it hangs up; a close without a word is a dropped line.
  socket.onclose = () => finish(call.error ?? "dropped");
}

/**
 * Starts a call to `url`. Run it from the member's tap the first time: the audio is woken
 * before anything is awaited, while the browser still counts the tap as permission to
 * make sound.
 */
export function startCall(target: {
  url: string;
  video: RefObject<HTMLVideoElement | null>;
  events: CallEvents;
}) {
  const context = callAudio();
  const call: Call = {
    player: createPlayer(context, target.events.onSpeaking),
    microphone: null,
    socket: null,
    frames: 0,
    error: null,
    over: false,
  };
  const finish = (failure: CallFailure | null) => {
    if (!call.over) {
      hangUp(call);
      target.events.onEnd(failure);
    }
  };
  openMicrophone(context, () => finish("microphone")).then(
    (microphone) => {
      call.microphone = microphone;
      // Hung up, or left, while the browser was still asking for the microphone.
      if (call.over) {
        return microphone.stop();
      }
      connect(call, microphone, target, finish);
    },
    () => finish("microphone"),
  );
  return {
    /** Hangs up. */
    end: () => finish(null),
    /** Hangs up quietly: the screen is going away. */
    leave: () => hangUp(call),
    /** Mutes the microphone; false while there's none open yet to mute. */
    mute: (muted: boolean) => {
      if (!call.microphone) {
        return false;
      }
      call.microphone.setMuted(muted);
      return true;
    },
    /** How loud Director is right now, from 0 to 1. */
    level: () => call.player.level(),
  };
}

export type CallControls = ReturnType<typeof startCall>;
