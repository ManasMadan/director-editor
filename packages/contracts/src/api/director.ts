/**
 * Director: how to film a YouTube short, worked out by Gemini in the AI service (apps/ai)
 * and served by apps/api. A workspace's plans are its library of templates, shared by its
 * members: the seeded ones every workspace starts with, and the one short each member
 * may index themselves. Takes, their reviews and the cuts made of them are each member's
 * own.
 *
 * The plan's shape mirrors the Python service's ShotPlan (apps/ai/app/schemas.py), which
 * is the model's output type; a test in apps/api compares the two through the generated
 * AI client's schemas. Positions are fractions of a 9:16 portrait frame, from its top-left.
 */
import * as z from "zod";
import {
  directorCutIdSchema,
  directorPlanIdSchema,
  directorTakeIdSchema,
  fileIdSchema,
  videoIdSchema,
} from "../ids";
import { HOUR_S, MINUTE_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";
import { SHORT_URL_MAX_LENGTH } from "./shorts";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_INDEX_LIMIT",
  "DIRECTOR_VIDEO_UNAVAILABLE",
  "DIRECTOR_TOO_LONG",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_SHOT_NOT_FOUND",
  "DIRECTOR_TAKE_NOT_FOUND",
  "DIRECTOR_TAKE_KIND_MISMATCH",
  "FILE_NOT_FOUND",
  "FILE_NOT_READY",
);

export const DIRECTOR_MAX_SHOTS = 12;
/** A shot needs a retake when its best take scored below this (out of 100). */
export const DIRECTOR_RETAKE_BELOW = 60;
/** A cut's title becomes its YouTube title, which YouTube caps at 100 characters. */
const DIRECTOR_CUT_TITLE_MAX_LENGTH = 100;
/** A take's longest: what a 15 MB upload holds at the recorder's bitrate. */
const DIRECTOR_MAX_SHOT_SECONDS = 60;
/** A scene check's camera frame, base64 (a 640-pixel JPEG is 40-120 kB). */
export const DIRECTOR_FRAME_MAX_LENGTH = 400_000;
export const DIRECTOR_FRAME_MIN_LENGTH = 100;
/** A line Director says aloud: a guide, a cue or a script line, never a speech. */
const DIRECTOR_SPEECH_MAX_LENGTH = 500;
/** The voices Director may speak in (Gemini's prebuilt text-to-speech voices). */
const directorVoices = ["Puck", "Kore", "Aoede", "Charon", "Sulafat"] as const;
export type DirectorVoice = (typeof directorVoices)[number];

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
  /** A seeded template every workspace starts with, or a short a member indexed. */
  source: z.enum(["seed", "user"]),
  /** pending → analyzing → ready (or failed, with an error code). */
  status: z.enum(["pending", "analyzing", "ready", "failed"]),
  /** How far indexing got, finer than `status`, for showing its progress. */
  stage: z.enum(["queued", "watching", "writing", "ready", "failed"]),
  error: z.string().nullable(),
  plan: shotPlanSchema.nullable(),
  model: z.string().nullable(),
  /**
   * The short's original audio, to film along to: `url` is a short-lived link to it,
   * while it's `ready` and uploads are on (null otherwise); `failed` means it couldn't be
   * fetched (the microphone is used instead), `none` that it wasn't tried.
   */
  audio: z.object({
    status: z.enum(["ready", "failed", "none"]),
    url: z.url().nullable(),
  }),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type DirectorPlan = z.infer<typeof directorPlanSchema>;

const directorLibrarySchema = z.object({
  /** The workspace's plans, newest first: seeded templates and members' own shorts. */
  templates: z.array(directorPlanSchema),
  /** The caller has indexed their one short of their own (a failed one doesn't count). */
  indexUsed: z.boolean(),
});
export type DirectorLibrary = z.infer<typeof directorLibrarySchema>;

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

/** A shot of the plan with the caller's takes of it, newest first. */
const directorShotSchema = z.object({
  index: shotIndex,
  takes: z.array(directorTakeSchema),
  /** The best-scored take (the newest of a tie); null until one is scored. */
  pickedTakeId: directorTakeIdSchema.nullable(),
  /** The picked take scored below DIRECTOR_RETAKE_BELOW. */
  needsRetake: z.boolean(),
});
export type DirectorShot = z.infer<typeof directorShotSchema>;

/** The take picked for each shot used in a cut, by shot index. */
const picksSchema = z.record(shotIndex, directorTakeIdSchema);

export const directorCutSchema = z.object({
  id: directorCutIdSchema,
  planId: directorPlanIdSchema,
  videoId: videoIdSchema,
  /** The plan's title (the template the cut was made from). */
  templateTitle: z.string(),
  title: z.string(),
  picks: picksSchema,
  /** The rendered video: a `director-cut-video` upload. */
  fileId: fileIdSchema,
  durationMs: z.number().int().nonnegative(),
  createdAt: z.date(),
  publish: z.object({
    status: z.enum(["none", "uploading", "published", "failed"]),
    youtubeVideoId: z.string().nullable(),
    /** YouTube's privacy status, as published. */
    visibility: z.enum(["private", "unlisted", "public"]).nullable(),
  }),
});
export type DirectorCut = z.infer<typeof directorCutSchema>;

/** A spoken line, stored as a WAV file: a short-lived link to play it from. */
const directorSpeechSchema = z.object({ url: z.url(), expiresAt: z.date() });
export type DirectorSpeech = z.infer<typeof directorSpeechSchema>;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Director"], summary });

export const directorContract = {
  /** The workspace's templates, and whether the caller has indexed their own short. */
  library: route("GET", "/director/library", "Your workspace's templates").output(
    directorLibrarySchema,
  ),
  /**
   * Indexes a short from its YouTube link (watch, shorts or youtu.be): Director watches
   * it and works out its plan. The link must be a video YouTube shows
   * (DIRECTOR_VIDEO_UNAVAILABLE) and a Short (DIRECTOR_TOO_LONG). Each member indexes one
   * short of their own (DIRECTOR_INDEX_LIMIT; one that failed doesn't count, and is tried
   * again). A short already in the library is answered with its plan, counting for no one.
   */
  index: route("POST", "/director/library", "Index a short")
    .meta({ rateLimit: { name: "director-index", points: 10, windowSeconds: HOUR_S, per: "user" } })
    .input(z.object({ url: z.string().trim().min(1).max(SHORT_URL_MAX_LENGTH) }))
    .output(directorPlanSchema),
  /** The workspace's plan for a short (DIRECTOR_PLAN_NOT_FOUND unless it's in the library). */
  plan: route("GET", "/director/{videoId}/plan", "A short's plan")
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
  /**
   * A line in Director's own voice (Gemini's text-to-speech), for the shoot screen to play
   * when the member isn't on a live call. The same line in the same voice is spoken once
   * and kept, so asking again costs no model call. Needs uploads on (FEATURE_DISABLED).
   */
  speak: route("POST", "/director/speech", "Hear a line in Director's voice")
    .meta({
      rateLimit: { name: "director-speech", points: 60, windowSeconds: MINUTE_S, per: "user" },
    })
    .input(
      z.object({
        text: z.string().trim().min(1).max(DIRECTOR_SPEECH_MAX_LENGTH),
        voice: z.enum(directorVoices),
      }),
    )
    .output(directorSpeechSchema),
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
  /**
   * Each shot of a ready plan with the caller's takes of it, the take picked for it and
   * whether it needs a retake (DIRECTOR_PLAN_NOT_READY before the plan is ready).
   */
  shots: route("GET", "/director/{videoId}/shots", "Your takes, shot by shot")
    .input(z.object({ videoId: videoIdSchema }))
    .output(z.array(directorShotSchema)),
  /** The caller's cuts of a short, newest first. */
  cuts: route("GET", "/director/{videoId}/cuts", "Your cuts of a short")
    .input(z.object({ videoId: videoIdSchema }))
    .output(z.array(directorCutSchema)),
  /**
   * Saves a cut: a ready `director-cut-video` upload of the caller's (FILE_NOT_FOUND,
   * FILE_NOT_READY) and the take of theirs picked for each shot it uses, each a take of
   * that shot (DIRECTOR_SHOT_NOT_FOUND, DIRECTOR_TAKE_NOT_FOUND).
   */
  saveCut: route("POST", "/director/{videoId}/cuts", "Save a cut")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      z.object({
        videoId: videoIdSchema,
        picks: picksSchema.refine((picks) => Object.keys(picks).length > 0),
        fileId: fileIdSchema,
        title: z.string().trim().min(1).max(DIRECTOR_CUT_TITLE_MAX_LENGTH),
      }),
    )
    .output(directorCutSchema),
  /** Every cut of the caller's, newest first (the client groups them by template). */
  media: route("GET", "/media", "Your cuts").output(z.array(directorCutSchema)),
};
