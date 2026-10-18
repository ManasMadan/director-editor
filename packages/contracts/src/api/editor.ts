/**
 * The conversational editor: the member tells Director, typed or said, what to change in
 * their edit ("for shot 1, use the one with the parrot behind me", "end shot 2 on the
 * smile", "captions off"), and Director answers with edits the browser applies to its
 * own edit history (apps/web lib/editor-actions.ts), a question with candidate takes, or
 * a kind no. Gemini reads each take's index, written when the take was reviewed, so
 * nothing is watched again. The edit itself stays in the browser until it's saved.
 */
import * as z from "zod";
import { directorTakeIdSchema, videoIdSchema } from "../ids";
import { MINUTE_S } from "../time";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";
import { DIRECTOR_MAX_SHOTS } from "./director";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
);

const EDITOR_TEXT_MAX_LENGTH = 500;
/** About a minute of speech (Opus in WebM or MP4), base64. */
const EDITOR_AUDIO_MAX_LENGTH = 1_400_000;
const EDITOR_MAX_FIXES = 20;
/** The longest a take can be, in seconds (apps/ai MAX_SHOT_SECONDS). */
const TAKE_MAX_SECONDS = 60;

export const editorGrades = [
  "none",
  "black-and-white",
  "warm",
  "cool",
  "high-contrast",
  "vintage",
  "vivid",
] as const;
export type EditorGrade = (typeof editorGrades)[number];

const editorOps = [
  "pick_take",
  "trim",
  "move_shot",
  "swap_shots",
  "drop_shot",
  "restore_shot",
  "captions",
  "edit_caption",
  "set_grade",
  "set_volume",
  "asset_request",
  "reset_to_picks",
  "undo",
  "redo",
  "reshoot",
] as const;

const shotIndex = z
  .number()
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);
const takeSeconds = z.number().min(0).max(TAKE_MAX_SECONDS);

/** The edit as the browser holds it, for Director to read. */
const editorStateSchema = z.object({
  shots: z
    .array(
      z.object({
        shotIndex,
        /** The take playing, or null when the shot has none yet. */
        takeId: directorTakeIdSchema.nullable(),
        /** The part of the take played, in seconds from its start. */
        startSeconds: takeSeconds,
        endSeconds: takeSeconds,
        /** Its place in the video, or null when it's dropped. */
        position: shotIndex.nullable(),
        grade: z.enum(editorGrades),
      }),
    )
    .max(DIRECTOR_MAX_SHOTS),
  captions: z.enum(["pop", "classic", "off"]),
  sound: z.boolean(),
  /** Whether the video has a music track. */
  music: z.boolean(),
  /** Words the captions show differently: "cloud" shown as "Claude". */
  fixes: z
    .array(z.object({ text: z.string().min(1).max(80), replacement: z.string().max(80) }))
    .max(EDITOR_MAX_FIXES),
});
export type EditorState = z.infer<typeof editorStateSchema>;

const editorActionSchema = z.object({
  op: z.enum(editorOps),
  shotIndex: z.number().int().nullable(),
  takeId: directorTakeIdSchema.nullable(),
  otherShotIndex: z.number().int().nullable(),
  position: z.number().int().nullable(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  value: z.string().nullable(),
  level: z.number().nullable(),
  text: z.string().nullable(),
  replacement: z.string().nullable(),
  steps: z.number().int().nullable(),
});
export type EditorAction = z.infer<typeof editorActionSchema>;

export const editorReplySchema = z.object({
  /** What Director understood was asked, in the member's words (shown for speech). */
  heard: z.string(),
  /**
   * applied: the actions are the change. ask: several takes match, pick one of the
   * choices. no-match: none does; the choices are the closest. declined: out of reach.
   * confirm: costly or destructive, asked first. answer: only words. Only `applied`
   * carries actions.
   */
  outcome: z.enum(["applied", "ask", "no-match", "declined", "confirm", "answer"]),
  /** Director's one line about it. */
  say: z.string(),
  actions: z.array(editorActionSchema),
  /** Candidate takes, with the moment to preview and why. */
  choices: z.array(
    z.object({
      shotIndex: z.number().int(),
      takeId: directorTakeIdSchema,
      atSeconds: z.number(),
      note: z.string(),
    }),
  ),
});
export type EditorReply = z.infer<typeof editorReplySchema>;

const route = (method: "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Editor"], summary });

export const editorContract = {
  /**
   * A request to Director in the editor, typed (`text`) or said (`audio`, base64, with
   * its type), with the edit as it is now. A model call each time.
   */
  ask: route("POST", "/director/{videoId}/editor-requests", "Ask Director to change the edit")
    .meta({
      rateLimit: { name: "director-editor", points: 30, windowSeconds: MINUTE_S, per: "user" },
    })
    .input(
      z
        .object({
          videoId: videoIdSchema,
          text: z.string().trim().min(1).max(EDITOR_TEXT_MAX_LENGTH).nullable(),
          audio: z.string().min(100).max(EDITOR_AUDIO_MAX_LENGTH).nullable(),
          audioType: z.enum(["audio/webm", "audio/mp4", "audio/ogg"]).nullable(),
          state: editorStateSchema,
        })
        .refine(
          (input) => input.text !== null || (input.audio !== null && input.audioType !== null),
        ),
    )
    .output(editorReplySchema),
};
