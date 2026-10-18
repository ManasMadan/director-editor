/**
 * The messages of Director live. Between the browser and this API: the shared schemas in
 * @repo/contracts/live. Between this API and Vertex AI: the Live API's own JSON, of which
 * only the fields the relay uses are parsed here; the rest is ignored.
 */
import { DIRECTOR_FRAME_MAX_LENGTH } from "@repo/contracts/api";
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
  /** This connection is about to close: time to move to a new one. */
  goAway: z.object({ timeLeft: z.string().optional() }).optional(),
  /** A handle a new connection can resume the conversation from, when it's resumable. */
  sessionResumptionUpdate: z
    .object({ newHandle: z.string().optional(), resumable: z.boolean().optional() })
    .optional(),
});
export type UpstreamMessage = z.infer<typeof upstreamMessageSchema>;

/**
 * A tool's arguments from Gemini, by tool. A shot is numbered from 1, as Gemini reads
 * the plan; the relay checks it against the plan before the browser sees it.
 */
export const toolArgsSchemas = {
  go_to_shot: z.object({ shot: z.number().int() }),
  switch_camera: z.object({ to: z.enum(["front", "back"]) }),
};
