/**
 * The member's version of a template: what Director remembers from the conversation
 * ("inside", "one angle"), how it changed each shot for them, and which shots they
 * skipped or left as gaps for the editor to fill. It comes only from talking to
 * Director, is kept per member and template, and is what the shoot screen, Director live
 * and the editor all read, so a reload or a new connection carries on with it.
 *
 * `revise` is Director re-planning what's left from one instruction ("one position,
 * front camera", "three shots, two minutes"): Gemini, in the AI service, rewrites the
 * version from the plan, the version so far and the instruction.
 */
import * as z from "zod";
import { videoIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";
import { DIRECTOR_MAX_SHOTS, type Shot } from "./director";

/** What a remembered note is about: the chips' kinds. */
export const MEMORY_KINDS = [
  "place",
  "people",
  "props",
  "time",
  "angles",
  "comfort",
  "style",
  "other",
] as const;
/** A note is a chip's label: a word or three ("Inside", "One angle"), never a sentence. */
const MEMORY_NOTE_MAX_LENGTH = 60;
export const MEMORY_MAX_NOTES = 12;
/** One row of a shot as the member's version has it: a sentence, not a script. */
export const VERSION_ROW_MAX_LENGTH = 300;
/** A shot's title in the member's version, as long as a plan's (apps/ai Shot.title). */
export const SHOT_TITLE_MAX_LENGTH = 80;
/** A re-planning instruction: one thing the member wants, in Director's words. */
export const REVISE_INSTRUCTION_MAX_LENGTH = 300;
/** Director's one-line confirmation of a re-plan. */
const REVISE_SUMMARY_MAX_LENGTH = 300;

const shotIndex = z
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);
const row = z.string().trim().min(1).max(VERSION_ROW_MAX_LENGTH);

export const memoryNoteSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  note: z.string().trim().min(1).max(MEMORY_NOTE_MAX_LENGTH),
});
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

/**
 * A shot as the member's version changes it: its title (when re-planning or adapting it
 * moved it somewhere the original's title names no more), where to be, what to do, the
 * line, the framing in words and the camera. Each is optional; one left out stays the
 * original's.
 */
export const shotVersionSchema = z.object({
  shot: shotIndex,
  title: z.string().trim().min(1).max(SHOT_TITLE_MAX_LENGTH).optional(),
  where: row.optional(),
  action: row.optional(),
  line: row.optional(),
  framing: row.optional(),
  camera: z.enum(["front", "back"]).optional(),
});
export type ShotVersion = z.infer<typeof shotVersionSchema>;

const shotList = z
  .array(shotIndex)
  .max(DIRECTOR_MAX_SHOTS)
  .transform((shots) => [...new Set(shots)].toSorted((a, b) => a - b));

export const yourVersionSchema = z.object({
  notes: z.array(memoryNoteSchema).max(MEMORY_MAX_NOTES),
  /** At most one entry a shot; a shot with none is the original. */
  shots: z.array(shotVersionSchema).max(DIRECTOR_MAX_SHOTS),
  /** Shots left out of their video altogether. */
  skipped: shotList,
  /** Shots not filmed that the editor fills (B-roll, stock, the template's assets). */
  gaps: shotList,
});
export type YourVersion = z.infer<typeof yourVersionSchema>;

export const EMPTY_VERSION: YourVersion = { notes: [], shots: [], skipped: [], gaps: [] };

/**
 * The shot as the member's version has it: their title, their place as the scene, what
 * they do as the first step (or the pose, with no steps), their line said across the
 * whole shot (its timing was the original's), their framing in words and their camera.
 * The shoot screen and the editor show it, Director live is briefed with it and the AI
 * service reviews takes against it (apps/ai app/your_version.py mirrors this), so none
 * brings up the original's place or setup once the member's version has replaced it.
 */
export function applyShotVersion(shot: Shot, version: ShotVersion | undefined): Shot {
  if (!version) {
    return shot;
  }
  const { title, where, action, line, framing, camera } = version;
  const [first, ...rest] = shot.steps;
  return {
    ...shot,
    title: title ?? shot.title,
    scene: where ?? shot.scene,
    // The original's landmark belongs to the original's place.
    sceneLandmark: where ? null : shot.sceneLandmark,
    steps: action && first ? [{ ...first, instruction: action }, ...rest] : shot.steps,
    pose: action && !first ? { ...shot.pose, description: action } : shot.pose,
    script: line
      ? [{ startSeconds: 0, endSeconds: shot.durationSeconds, text: line }]
      : shot.script,
    framing: framing ? { ...shot.framing, note: framing } : shot.framing,
    camera: camera ?? shot.camera,
  };
}

/** Whether the member films shot `index`: skipped shots and gaps aren't filmed. */
export function films(version: YourVersion, index: number): boolean {
  return !(version.skipped.includes(index) || version.gaps.includes(index));
}

/** The next shot after `index` they film, or null when there's none left. */
export function nextFilmed(version: YourVersion, index: number, count: number): number | null {
  for (let next = index + 1; next < count; next += 1) {
    if (films(version, next)) {
      return next;
    }
  }
  return null;
}

/**
 * The shot they film nearest to `index`: itself when they film it, else the next one
 * they film, else the one before; null when they film none of the plan.
 */
export function nearestFilmed(version: YourVersion, index: number, count: number): number | null {
  if (films(version, index)) {
    return index;
  }
  const next = nextFilmed(version, index, count);
  if (next !== null) {
    return next;
  }
  for (let before = index - 1; before >= 0; before -= 1) {
    if (films(version, before)) {
      return before;
    }
  }
  return null;
}

const reviseResultSchema = z.object({
  version: yourVersionSchema,
  /** What changed, in a line, for Director to confirm in its own words. */
  summary: z.string().max(REVISE_SUMMARY_MAX_LENGTH),
});
export type ReviseResult = z.infer<typeof reviseResultSchema>;

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
);

const route = (method: "GET" | "PUT" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Director"], summary });

export const yourVersionContract = {
  /** The caller's version of the template (empty until Director changes something). */
  get: route("GET", "/director/{videoId}/version", "Your version of a template")
    .input(z.object({ videoId: videoIdSchema }))
    .output(yourVersionSchema),
  /** Keeps the caller's version of the template, as the shoot screen has it now. */
  save: route("PUT", "/director/{videoId}/version", "Keep your version of a template")
    .errors(errorsOf("DEMO_ACCOUNT_LOCKED"))
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ videoId: videoIdSchema, version: yourVersionSchema }))
    .output(yourVersionSchema),
  /**
   * Re-plans the caller's version from one instruction (a model call), keeps it and
   * answers with it and a line saying what changed. The plan must be ready.
   */
  revise: route("POST", "/director/{videoId}/revisions", "Re-plan your version")
    .errors(errorsOf("DEMO_ACCOUNT_LOCKED"))
    .meta({
      rateLimit: { name: "director-revise", points: 30, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({
        videoId: videoIdSchema,
        instruction: z.string().trim().min(1).max(REVISE_INSTRUCTION_MAX_LENGTH),
        version: yourVersionSchema,
      }),
    )
    .output(reviseResultSchema),
};
