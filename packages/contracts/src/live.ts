/**
 * Director's live video call, as the browser and the API speak it over the WebSocket at
 * `LIVE_PATH`: JSON text frames, each an object with a `type`. The API's relay
 * (apps/api/src/modules/live) parses what the browser sends with `liveClientMessage`
 * and the web app parses what comes back with `liveServerMessage`, so both sides agree
 * on one shape. It isn't part of the oRPC contract: a call is a socket, not a procedure.
 */
import * as z from "zod";
import { DIRECTOR_FRAME_MAX_LENGTH, DIRECTOR_MAX_SHOTS } from "./api/director";
import { errorCode } from "./errors";

export const LIVE_PATH = "/api/live";

/** What Director can do to the camera app during a call (Gemini's function calls). */
export const LIVE_TOOLS = [
  "start_recording",
  "stop_recording",
  "next_shot",
  "previous_shot",
  "retake",
] as const;
const liveTool = z.enum(LIVE_TOOLS);
export type LiveTool = z.infer<typeof liveTool>;

/** About two seconds of 16 kHz 16-bit mono audio, base64; the browser sends ~100 ms at a time. */
const LIVE_AUDIO_MAX_LENGTH = 90_000;
const LIVE_TEXT_MAX_LENGTH = 2000;
/** The reason Director gives for a tool call; a longer one is cut to this. */
export const LIVE_TOOL_REASON_MAX_LENGTH = 500;

const shotIndex = z
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);

/** From the browser: the microphone, a camera frame, a typed line, or a move to another shot. */
export const liveClientMessage = z.discriminatedUnion("type", [
  /** 16 kHz 16-bit little-endian mono PCM. */
  z.object({ type: z.literal("audio"), pcm16: z.base64().min(4).max(LIVE_AUDIO_MAX_LENGTH) }),
  z.object({ type: z.literal("frame"), jpeg: z.base64().min(4).max(DIRECTOR_FRAME_MAX_LENGTH) }),
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(LIVE_TEXT_MAX_LENGTH) }),
  /** The member is on another shot of the plan now: Director directs that one. */
  z.object({ type: z.literal("shot"), shot: shotIndex }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessage>;

/** To the browser: Director's voice, both sides' words, its tool calls, and why a call ended. */
export const liveServerMessage = z.discriminatedUnion("type", [
  /** 24 kHz 16-bit little-endian mono PCM. */
  z.object({ type: z.literal("audio"), pcm16: z.base64() }),
  z.object({
    type: z.literal("transcript"),
    who: z.enum(["you", "director"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool"),
    name: liveTool,
    args: z.object({ reason: z.string().max(LIVE_TOOL_REASON_MAX_LENGTH).optional() }),
  }),
  /** The member spoke over Director: drop the audio still queued to play. */
  z.object({ type: z.literal("interrupted") }),
  /**
   * Why the call is ending, just before the socket closes. A code newer than the reader
   * reads as INTERNAL: still a failure, never an unreadable message.
   */
  z.object({ type: z.literal("error"), code: errorCode.catch("INTERNAL") }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessage>;
