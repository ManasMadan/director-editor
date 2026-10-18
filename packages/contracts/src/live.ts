/**
 * Director live on the shoot screen, as the browser and the API speak it over the
 * WebSocket at `LIVE_PATH`: JSON text frames, each an object with a `type`. The API's
 * relay (apps/api/src/modules/live) parses what the browser sends with
 * `liveClientMessage` and the web app parses what comes back with `liveServerMessage`,
 * so both sides agree on one shape. It isn't part of the oRPC contract: Director live is
 * a socket, not a procedure.
 */
import * as z from "zod";
import { DIRECTOR_FRAME_MAX_LENGTH, DIRECTOR_MAX_SHOTS } from "./api/director";
import { errorCode } from "./errors";

export const LIVE_PATH = "/api/live";

/**
 * What Director can do on the shoot screen (Gemini's function calls). Nothing here starts
 * or stops a take: only the member's own tap on the shutter does that.
 */
export const LIVE_TOOLS = ["go_to_shot", "switch_camera"] as const;
export type LiveTool = (typeof LIVE_TOOLS)[number];

/** About two seconds of 16 kHz 16-bit mono audio, base64; the browser sends ~100 ms at a time. */
const LIVE_AUDIO_MAX_LENGTH = 90_000;
const LIVE_TEXT_MAX_LENGTH = 2000;
/** A tool call's id, as the relay hands it to the browser and the browser hands it back. */
const LIVE_TOOL_ID_MAX_LENGTH = 64;

const shotIndex = z
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);
const facing = z.enum(["front", "back"]);
export type Facing = z.infer<typeof facing>;

/** A tool call as the browser carries it out: which, and with what (a shot is 0-based). */
const liveToolCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal("go_to_shot"), shot: shotIndex }),
  z.object({ name: z.literal("switch_camera"), to: facing }),
]);
export type LiveToolCall = z.infer<typeof liveToolCall>;

/**
 * What came of a tool call: done, or refused because a take is under way (counting down,
 * recording, being watched back or sent) or there's no camera on to switch.
 */
const LIVE_TOOL_RESULTS = ["done", "busy", "no_camera"] as const;
export type LiveToolResult = (typeof LIVE_TOOL_RESULTS)[number];

/**
 * Where a take is: counting in (the 3-2-1), the count called off, recording, just
 * recorded (the member is watching it back), or thrown away to go again.
 */
const LIVE_TAKE_STATES = ["countdown", "cancelled", "recording", "recorded", "discarded"] as const;
export type LiveTakeState = (typeof LIVE_TAKE_STATES)[number];

/**
 * From the browser: the microphone, a camera frame, a typed line, a move to another shot,
 * what came of a tool call, and what the member did on screen (flipped the camera, took a
 * take). The relay turns the last two into notes for Director in its own words, so the
 * browser never writes what Director is told.
 */
export const liveClientMessage = z.discriminatedUnion("type", [
  /** 16 kHz 16-bit little-endian mono PCM. */
  z.object({ type: z.literal("audio"), pcm16: z.base64().min(4).max(LIVE_AUDIO_MAX_LENGTH) }),
  z.object({ type: z.literal("frame"), jpeg: z.base64().min(4).max(DIRECTOR_FRAME_MAX_LENGTH) }),
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(LIVE_TEXT_MAX_LENGTH) }),
  /** The member is on another shot of the plan now: Director directs that one. */
  z.object({ type: z.literal("shot"), shot: shotIndex }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string().min(1).max(LIVE_TOOL_ID_MAX_LENGTH),
    result: z.enum(LIVE_TOOL_RESULTS),
  }),
  /** The member flipped the camera: it faces this way now, and Director sees that side. */
  z.object({ type: z.literal("camera"), facing }),
  z.object({ type: z.literal("take"), state: z.enum(LIVE_TAKE_STATES) }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessage>;

/** To the browser: Director's voice, both sides' words, its tool calls, and why it stopped. */
export const liveServerMessage = z.discriminatedUnion("type", [
  /** 24 kHz 16-bit little-endian mono PCM. */
  z.object({ type: z.literal("audio"), pcm16: z.base64() }),
  z.object({
    type: z.literal("transcript"),
    who: z.enum(["you", "director"]),
    text: z.string(),
  }),
  /** Do this, then answer with a `tool_result` carrying the same id. */
  z.object({
    type: z.literal("tool"),
    id: z.string().min(1).max(LIVE_TOOL_ID_MAX_LENGTH),
    call: liveToolCall,
  }),
  /** The member spoke over Director: drop the audio still queued to play. */
  z.object({ type: z.literal("interrupted") }),
  /** Director finished what it had to say: its next words start a new line. */
  z.object({ type: z.literal("turn") }),
  /**
   * Why Director is going away, just before the socket closes. A code newer than the
   * reader reads as INTERNAL: still a failure, never an unreadable message.
   */
  z.object({ type: z.literal("error"), code: errorCode.catch("INTERNAL") }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessage>;
