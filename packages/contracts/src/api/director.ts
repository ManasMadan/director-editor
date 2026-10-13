/**
 * Director: how to film a YouTube short, worked out by Gemini in the AI service (apps/ai)
 * and served by apps/api. A workspace's plan for a video is shared by its members; takes
 * and their reviews are each member's own.
 *
 * The plan's shape mirrors the Python service's ShotPlan (apps/ai/app/schemas.py), which
 * is the model's output type; a test in apps/api compares the two through the generated
 * AI client's schemas. Positions are fractions of a 9:16 portrait frame, from its top-left.
 */
import * as z from "zod";
import { directorPlanIdSchema, directorTakeIdSchema, fileIdSchema, videoIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "SHORT_NOT_FOUND",
  "SHORT_TOO_LONG",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_SHOT_NOT_FOUND",
  "DIRECTOR_TAKE_KIND_MISMATCH",
  "FILE_NOT_FOUND",
  "FILE_NOT_READY",
);

export const DIRECTOR_MAX_SHOTS = 12;
/** A take's longest: what a 15 MB upload holds at the recorder's bitrate. */
const DIRECTOR_MAX_SHOT_SECONDS = 60;
/** A scene check's camera frame, base64 (a 640-pixel JPEG is 40-120 kB). */
export const DIRECTOR_FRAME_MAX_LENGTH = 400_000;
export const DIRECTOR_FRAME_MIN_LENGTH = 100;

const fraction = z.number().min(0).max(1);
const boxSchema = z.object({
  x: fraction,
  y: fraction,
  width: z.number().min(0.01).max(1),
  height: z.number().min(0.01).max(1),
});
export type FrameBox = z.infer<typeof boxSchema>;

export const keypointNames = [
  "nose",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;
export type KeypointName = (typeof keypointNames)[number];

const cameraMoves = [
  "static",
  "up",
  "down",
  "left",
  "right",
  "forward",
  "back",
  "orbit",
  "tilt-up",
  "tilt-down",
] as const;
export type CameraMove = (typeof cameraMoves)[number];

const sceneDirections = [
  "none",
  "left",
  "right",
  "forward",
  "back",
  "turn-left",
  "turn-right",
] as const;

const seconds = z.number().min(0).max(DIRECTOR_MAX_SHOT_SECONDS);

const shotSchema = z.object({
  kind: z.enum(["video", "photo"]),
  title: z.string(),
  purpose: z.string(),
  /** Where it appears in the original. */
  sourceStartSeconds: z.number().min(0),
  sourceEndSeconds: z.number().min(0.1),
  /** How long it lasts in the edit (a photo: how long it is shown). */
  durationSeconds: z.number().min(0.5).max(DIRECTOR_MAX_SHOT_SECONDS),
  camera: z.enum(["front", "back"]),
  /** Where to be, spoken and written: "Stand near a tree". */
  scene: z.string(),
  /** The one thing the scene needs ("tree"), looked for in the camera. */
  sceneLandmark: z.string().nullable(),
  framing: z.object({
    shotSize: z.enum(["close-up", "medium", "full-body", "wide"]),
    /** Where the person sits in frame: the outline on the viewfinder. */
    subject: boxSchema,
    note: z.string(),
  }),
  /** How to hold the phone: the bubble level's target. */
  phoneAngle: z.object({
    /** Degrees the camera points above (+) or below (-) the horizon. */
    pitch: z.number().min(-90).max(90),
    /** Degrees the phone leans clockwise (+) from upright. */
    roll: z.number().min(-45).max(45),
    tolerance: z.number().min(3).max(30),
    height: z.enum(["floor", "waist", "chest", "shoulder", "eye", "overhead"]),
  }),
  /** The body to match: the outline that locks when it does. */
  pose: z.object({
    description: z.string(),
    keypoints: z.array(z.object({ name: z.enum(keypointNames), x: fraction, y: fraction })),
  }),
  steps: z.array(
    z.object({ atSeconds: seconds, instruction: z.string(), cameraMove: z.enum(cameraMoves) }),
  ),
  /** The teleprompter's lines, timed from the shot's start; empty when nothing is said. */
  script: z.array(z.object({ startSeconds: seconds, endSeconds: seconds, text: z.string() })),
});
export type Shot = z.infer<typeof shotSchema>;

export const shotPlanSchema = z.object({
  title: z.string(),
  /** The trend, e.g. "GRWM". */
  format: z.string(),
  summary: z.string(),
  audio: z.enum(["speech", "music", "speech-and-music", "none"]),
  durationSeconds: z.number().min(0.5),
  shots: z.array(shotSchema).min(1).max(DIRECTOR_MAX_SHOTS),
});
export type ShotPlan = z.infer<typeof shotPlanSchema>;

export const directorPlanSchema = z.object({
  id: directorPlanIdSchema,
  videoId: videoIdSchema,
  /** pending → analyzing → ready (or failed, with an error code). */
  status: z.enum(["pending", "analyzing", "ready", "failed"]),
  error: z.string().nullable(),
  plan: shotPlanSchema.nullable(),
  model: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type DirectorPlan = z.infer<typeof directorPlanSchema>;

export const sceneCheckSchema = z.object({
  inPlace: z.boolean(),
  /** One spoken direction: "Move about five meters left, to the tree." */
  instruction: z.string(),
  direction: z.enum(sceneDirections),
  distanceMeters: z.number().min(0).nullable(),
  /** Where the scene's landmark is in the frame: drawn as a doodle around it. */
  landmark: z.object({ label: z.string(), box: boxSchema }).nullable(),
  lighting: z.enum(["good", "too-dark", "too-bright", "backlit"]),
});
export type SceneCheck = z.infer<typeof sceneCheckSchema>;

export const directorTakeSchema = z.object({
  id: directorTakeIdSchema,
  shotIndex: z.number().int().nonnegative(),
  fileId: fileIdSchema,
  kind: z.enum(["video", "photo"]),
  /** pending → reviewing → ready (or failed, with an error code). */
  status: z.enum(["pending", "reviewing", "ready", "failed"]),
  error: z.string().nullable(),
  /** The part of a video take worth keeping, in milliseconds from its start. */
  bestStartMs: z.number().int().nonnegative().nullable(),
  bestEndMs: z.number().int().positive().nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  feedback: z.string().nullable(),
  createdAt: z.date(),
});
export type DirectorTake = z.infer<typeof directorTakeSchema>;

const shotIndex = z
  .number()
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Director"], summary });

export const directorContract = {
  /** The workspace's plan for a short (DIRECTOR_PLAN_NOT_FOUND until someone asks for it). */
  plan: route("GET", "/director/{videoId}/plan", "A short's plan")
    .input(z.object({ videoId: videoIdSchema }))
    .output(directorPlanSchema),
  /**
   * Asks Director to work out a short (a no-op once it's queued or ready; a failed one is
   * tried again). The short must exist and be a short (SHORT_NOT_FOUND, SHORT_TOO_LONG).
   */
  requestPlan: route("POST", "/director/{videoId}/plan", "Ask Director to plan a short")
    .meta({ rateLimit: { name: "director-plans", points: 30, windowSeconds: HOUR_S, per: "user" } })
    .input(z.object({ videoId: videoIdSchema }))
    .output(directorPlanSchema),
  /** Where to go for a shot, from one camera frame (a model call each time). */
  checkScene: route("POST", "/director/{videoId}/scene-checks", "Check the scene for a shot")
    .meta({ rateLimit: { name: "director-scenes", points: 30, windowSeconds: 60, per: "user" } })
    .input(
      z.object({
        videoId: videoIdSchema,
        shotIndex,
        image: z.string().min(DIRECTOR_FRAME_MIN_LENGTH).max(DIRECTOR_FRAME_MAX_LENGTH),
      }),
    )
    .output(sceneCheckSchema),
  /** The caller's takes for the short, newest first. */
  takes: route("GET", "/director/{videoId}/takes", "Your takes for a short")
    .input(z.object({ videoId: videoIdSchema }))
    .output(z.array(directorTakeSchema)),
  /**
   * Records an uploaded take (a ready `director-take-video` or `director-take-photo` file of
   * the caller's) for a shot, and queues its review.
   */
  addTake: route("POST", "/director/{videoId}/takes", "Add a take for a shot")
    .meta({
      rateLimit: { name: "director-takes", points: 120, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({
        videoId: videoIdSchema,
        shotIndex,
        kind: z.enum(["video", "photo"]),
        fileId: fileIdSchema,
      }),
    )
    .output(directorTakeSchema),
};
