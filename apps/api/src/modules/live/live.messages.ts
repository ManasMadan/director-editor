/**
 * The messages of a live call. Between the browser and this API: the shared schemas in
 * @repo/contracts/live. Between this API and Vertex AI: the Live API's own JSON, of which
 * only the fields the relay uses are parsed here; the rest is ignored.
 */
import { DIRECTOR_FRAME_MAX_LENGTH } from "@repo/contracts/api";
import { LIVE_TOOL_REASON_MAX_LENGTH } from "@repo/contracts/live";
import * as z from "zod";

/** The largest frame the browser may send: a frame, with room for its JSON around it. */
export const CLIENT_MAX_PAYLOAD_BYTES = DIRECTOR_FRAME_MAX_LENGTH + 4096;
/** Vertex sends audio in small chunks; anything near this is not a message we want. */
export const UPSTREAM_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

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

/**
 * A tool's arguments from Gemini, as the browser gets them: the optional reason, nothing
 * else. A long reason is cut short; the call itself is still the one the director asked for.
 */
export const toolArgsSchema = z.object({
  reason: z
    .string()
    .transform((reason) => reason.slice(0, LIVE_TOOL_REASON_MAX_LENGTH))
    .optional(),
});
