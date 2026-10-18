/**
 * Director's slower line (`director.chat`): when Gemini Live can't run, the shoot screen
 * talks to Director one turn at a time. The member's turn (typed, or dictated by the
 * browser), or something that happened on screen, goes up with the latest camera frame,
 * the shot, what the shoot has changed and the last few lines said; Director's reply and
 * its tool calls come back, the same tools as on Live, carried out by the same code in
 * the browser. The reply is spoken with `director.speak`.
 *
 * It lives apart from ./director.ts because it speaks Director live's vocabulary
 * (../live.ts), which itself reads the director contract's bounds.
 */
import * as z from "zod";
import { videoIdSchema } from "../ids";
import {
  facing,
  LIVE_ROLL_STATES,
  LIVE_TAKE_STATES,
  LIVE_TEXT_MAX_LENGTH,
  LIVE_TOOL_RESULTS,
  LIVE_TOOLS,
  liveAdaptation,
  liveToolCall,
} from "../live";
import { MINUTE_S } from "../time";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";
import {
  DIRECTOR_FRAME_MAX_LENGTH,
  DIRECTOR_FRAME_MIN_LENGTH,
  DIRECTOR_MAX_SHOTS,
} from "./director";
import { MEMORY_KINDS, memoryNoteSchema, yourVersionSchema } from "./your-version";

/** The last lines said, so Director carries on: an exchange or four. */
export const DIRECTOR_CHAT_RECENT_LINES = 8;
const RECENT_LINE_MAX_LENGTH = 300;

const shotIndex = z
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);

/**
 * What this turn is: the member said or typed something, the slower line just took over
 * (Director speaks first), they flipped the camera, a take moved on, or the roll (the
 * continuous recording) did.
 */
const directorChatTurn = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("said"),
    text: z.string().trim().min(1).max(LIVE_TEXT_MAX_LENGTH),
  }),
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("camera"), facing }),
  z.object({ kind: z.literal("take"), state: z.enum(LIVE_TAKE_STATES) }),
  z.object({ kind: z.literal("roll"), state: z.enum(LIVE_ROLL_STATES) }),
  /** The member took a chip away: Director lets it go. */
  z.object({
    kind: z.literal("forgot"),
    memory: z.enum(MEMORY_KINDS),
    note: memoryNoteSchema.shape.note,
  }),
]);
export type DirectorChatTurn = z.infer<typeof directorChatTurn>;

const directorChatInput = z.object({
  videoId: videoIdSchema,
  shotIndex,
  turn: directorChatTurn,
  /** What the camera shows now, as JPEG base64: none without a camera. */
  frame: z.base64().min(DIRECTOR_FRAME_MIN_LENGTH).max(DIRECTOR_FRAME_MAX_LENGTH).optional(),
  /** The member's version of each shot Director changed so far. */
  adaptations: z.array(liveAdaptation).max(DIRECTOR_MAX_SHOTS),
  /**
   * The member's whole version: what Director remembers, the shots changed, skipped and
   * left as gaps. Its shots win over `adaptations` when both are sent.
   */
  version: yourVersionSchema.optional(),
  /** The last lines said, oldest first. */
  recent: z
    .array(
      z.object({
        who: z.enum(["you", "director"]),
        text: z.string().trim().min(1).max(RECENT_LINE_MAX_LENGTH),
      }),
    )
    .max(DIRECTOR_CHAT_RECENT_LINES),
  /**
   * Whether the roll (the continuous recording) is recording now: Director then marks
   * each attempt as it starts and ends, as on Live.
   */
  rolling: z.boolean().optional(),
  /** What came of the tool calls of Director's last reply, as the screen carried them out. */
  answers: z
    .array(z.object({ tool: z.enum(LIVE_TOOLS), result: z.enum(LIVE_TOOL_RESULTS) }))
    .max(DIRECTOR_MAX_SHOTS),
});
export type DirectorChatInput = z.infer<typeof directorChatInput>;

/** Director's reply (empty when it has nothing to say, as after a note it only notes) and its calls. */
const directorChatReply = z.object({
  reply: z.string(),
  calls: z.array(liveToolCall),
});
export type DirectorChatReply = z.infer<typeof directorChatReply>;

export const directorChatContract = {
  /**
   * One turn of Director's slower line (Gemini Flash, with the same persona and tools as
   * Live). FEATURE_DISABLED while Director live is off; UPSTREAM_UNAVAILABLE when Gemini
   * can't be reached, which the shoot screen shows as Director being away.
   */
  chat: base
    .errors(
      errorsOf(
        ...WORKSPACE_ERRORS,
        "FEATURE_DISABLED",
        "UPSTREAM_UNAVAILABLE",
        "DIRECTOR_PLAN_NOT_FOUND",
        "DIRECTOR_SHOT_NOT_FOUND",
      ),
    )
    .route({
      method: "POST",
      path: "/director/{videoId}/chat",
      tags: ["Director"],
      summary: "Talk to Director, one turn at a time",
    })
    .meta({
      rateLimit: { name: "director-chat", points: 30, windowSeconds: MINUTE_S, per: "user" },
    })
    .input(directorChatInput)
    .output(directorChatReply),
};
