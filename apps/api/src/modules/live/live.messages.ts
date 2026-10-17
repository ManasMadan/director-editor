/**
 * The messages of a live call. Between the browser and this API: JSON text frames, each
 * an object with a `type`. Between this API and Vertex AI: the Live API's own JSON, of
 * which only the fields the relay uses are parsed; the rest is ignored.
 */
import { DIRECTOR_FRAME_MAX_LENGTH } from "@repo/contracts/api";
import type { ErrorCode } from "@repo/contracts/errors";
import * as z from "zod";
import type { LiveTool } from "./live.setup";

/** About two seconds of 16 kHz 16-bit mono audio, base64; clients send ~100 ms at a time. */
const AUDIO_MAX_LENGTH = 90_000;
const TEXT_MAX_LENGTH = 2000;
/** The largest frame the browser may send: a frame, with room for its JSON around it. */
export const CLIENT_MAX_PAYLOAD_BYTES = DIRECTOR_FRAME_MAX_LENGTH + 4096;
/** Vertex sends audio in small chunks; anything near this is not a message we want. */
export const UPSTREAM_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio"), pcm16: z.base64().min(4).max(AUDIO_MAX_LENGTH) }),
  z.object({ type: z.literal("frame"), jpeg: z.base64().min(4).max(DIRECTOR_FRAME_MAX_LENGTH) }),
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(TEXT_MAX_LENGTH) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** What the browser hears from the call. */
export type ServerMessage =
  | { type: "audio"; pcm16: string }
  | { type: "transcript"; who: "you" | "director"; text: string }
  | { type: "tool"; name: LiveTool; args: { reason?: string } }
  /** The filmer spoke over the director: drop the audio still queued to play. */
  | { type: "interrupted" }
  | { type: "error"; code: ErrorCode };

const transcription = z.object({ text: z.string().optional() }).optional();

export const upstreamMessageSchema = z.object({
  setupComplete: z.object({}).optional(),
  serverContent: z
    .object({
      modelTurn: z
        .object({
          parts: z
            .array(
              z.object({
                inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      interrupted: z.boolean().optional(),
      inputTranscription: transcription,
      outputTranscription: transcription,
    })
    .optional(),
  toolCall: z
    .object({
      functionCalls: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string(),
            args: z.unknown().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type UpstreamMessage = z.infer<typeof upstreamMessageSchema>;

const TOOL_REASON_MAX_LENGTH = 500;

/**
 * A tool's arguments as the browser gets them: the optional reason, nothing else. A long
 * reason is cut short; the call itself is still the one the director asked for.
 */
export const toolArgsSchema = z.object({
  reason: z
    .string()
    .transform((reason) => reason.slice(0, TOOL_REASON_MAX_LENGTH))
    .optional(),
});
