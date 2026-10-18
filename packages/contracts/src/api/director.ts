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

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_INDEX_LIMIT",
  "DIRECTOR_CREATE_LIMIT",
  "DIRECTOR_PLAN_NOT_EDITABLE",
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

/** Director films shorts: anything longer is refused (DIRECTOR_TOO_LONG). */
export const SHORT_MAX_SECONDS = 180;
/** A pasted YouTube link's longest. */
export const SHORT_URL_MAX_LENGTH = 300;
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

const keypointNames = [
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
  /** What its take is: a clip or a photo. */
  kind: z.enum(["video", "photo"]),
  /**
   * What the edit uses of it: the member on camera; only their voice (a voice-over, the
   * picture an asset or B-roll, from a video take); or nothing, an asset taking its place
   * (an end card, a full-screen graphic: a photo take stands in until the editor places
   * it). A plan written before modes is all on camera.
   */
  mode: z.enum(["on-camera", "voice-over", "asset"]).default("on-camera"),
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

// What a Short needs beyond the member filming themselves: the pieces it shows (assets)
// and the editing over the footage (edits). Times are seconds of the original, like a
// shot's source range; the editor maps them onto the member's takes through the shots'
// source ranges. An asset is never the original's picture: its reference describes it
// precisely enough to make a fresh one, from its prompt.
const DIRECTOR_MAX_ASSETS = 12;
const DIRECTOR_MAX_EDITS = 40;
const sourceSeconds = z.number().min(0).max(SHORT_MAX_SECONDS);
const sourceEnd = z.number().min(0.1).max(SHORT_MAX_SECONDS);
const assetId = z.string().max(40);
const color = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .nullable();
const assetKinds = [
  "image",
  "cutout",
  "text-card",
  "background",
  "broll",
  "music",
  "sfx",
  "end-card",
] as const;
const entrances = ["cut", "fade", "slide", "pop", "draw"] as const;

const assetSchema = z.object({
  /** Lowercase words joined by hyphens, unique in the plan ("chart"). */
  id: z
    .string()
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  kind: z.enum(assetKinds),
  /** A short name for it: "The archetypes chart". */
  title: z.string(),
  /** What it does in the Short, and where it sits. */
  role: z.string(),
  /** The original's piece, in a sentence or two. */
  description: z.string(),
  /** What it prompts an image model with: the Create tab's prompt, filled in. */
  prompt: z.string(),
  sourceStartSeconds: sourceSeconds,
  sourceEndSeconds: sourceEnd,
  defaultSource: z.enum(["create", "stock", "upload"]),
  /** The member could make it about their own topic. */
  personalisable: z.boolean(),
  /** What to ask the member for when it's theirs: "a photo of your dog". */
  ask: z.string().nullable(),
  /** The original shows it on another screen in shot. */
  secondScreen: z.boolean(),
  /** The original's piece, described precisely enough to recreate its look. */
  reference: z.object({
    subject: z.string(),
    composition: z.string(),
    style: z.string(),
    palette: z.string(),
    blackAndWhite: z.boolean(),
    aspectRatio: z.enum(["9:16", "3:4", "4:5", "1:1", "9:8", "5:4", "4:3", "16:9"]),
    /** Every line of text on it, word for word. */
    text: z.array(z.string()),
    /**
     * The original creator's own identity on it (their name, their channel, school or
     * business, handles, sites): never drawn into the member's version. A plan written
     * before it reads with none.
     */
    brands: z.array(z.string()).default([]),
    mood: z.string(),
  }),
});
export type Asset = z.infer<typeof assetSchema>;

const timed = { startSeconds: sourceSeconds, endSeconds: sourceEnd };
const editSchema = z.discriminatedUnion("type", [
  /**
   * How the frame is shared: the camera full frame (or an asset, for a voice-over), a
   * split with the camera on top or at the bottom taking `cameraShare` of the height and
   * the asset in the rest, or picture-in-picture with the `inset` in `box`.
   */
  z.object({
    type: z.literal("layout"),
    ...timed,
    layout: z.enum(["full", "split", "picture-in-picture"]),
    assetId: assetId.nullable(),
    cameraOn: z.enum(["top", "bottom"]).nullable(),
    cameraShare: z.number().min(0.2).max(0.8).nullable(),
    box: boxSchema.nullable(),
    inset: z.enum(["camera", "asset"]).nullable(),
  }),
  /** Something drawn over the frame: an asset, or a mark (a circle, an underline). */
  z.object({
    type: z.literal("overlay"),
    ...timed,
    assetId: assetId.nullable(),
    mark: z.enum(["circle", "underline", "arrow", "box", "highlight", "tick", "cross"]).nullable(),
    color,
    box: boxSchema,
    entry: z.enum(entrances),
    exit: z.enum(entrances),
  }),
  z.object({
    type: z.literal("grade"),
    ...timed,
    grade: z.enum(["black-and-white", "warm", "cool", "high-contrast", "vintage", "vivid"]),
    target: z.enum(["all", "camera", "assets"]),
  }),
  /** Words on screen. Captions carry no text of their own: they're the member's words. */
  z.object({
    type: z.literal("text"),
    ...timed,
    style: z.enum(["title", "lower-third", "captions", "label", "callout"]),
    text: z.string().nullable(),
    position: z.enum(["top", "middle", "bottom", "between-halves"]),
    captionStyle: z.enum(["word-by-word", "line", "boxed"]).nullable(),
    color,
    highlightColor: color,
  }),
  z.object({
    type: z.literal("transition"),
    ...timed,
    transition: z.enum(["cut", "match-cut", "whip", "fade", "zoom", "spin", "glitch"]),
    /** A match cut's anchor: what lines up. */
    anchor: z.string().nullable(),
  }),
  z.object({
    type: z.literal("speed"),
    ...timed,
    fromRate: z.number().min(0.1).max(8),
    toRate: z.number().min(0.1).max(8),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  }),
  z.object({
    type: z.literal("end-card"),
    ...timed,
    assetId: assetId.nullable(),
    text: z.string().nullable(),
  }),
  /** A moment to fill with B-roll or a cutaway: what it shows, for as long as it lasts. */
  z.object({ type: z.literal("gap"), ...timed, description: z.string() }),
]);

export const shotPlanSchema = z.object({
  title: z.string(),
  /** The trend, e.g. "GRWM". */
  format: z.string(),
  summary: z.string(),
  audio: z.enum(["speech", "music", "speech-and-music", "none"]),
  durationSeconds: z.number().min(0.5),
  shots: z.array(shotSchema).min(1).max(DIRECTOR_MAX_SHOTS),
  /** A plan written before assets and edits existed reads with neither. */
  assets: z.array(assetSchema).max(DIRECTOR_MAX_ASSETS).default([]),
  edits: z.array(editSchema).max(DIRECTOR_MAX_EDITS).default([]),
  /**
   * The original creator's own identity anywhere in the Short: never in the member's
   * version. Optional, so a plan typed before it still is one.
   */
  brands: z.array(z.string()).max(12).optional(),
});
export type ShotPlan = z.infer<typeof shotPlanSchema>;

// A plan as the API serves it. A seeded template opened on its own (`director.plan`, not
// the library) also links its media, made once for each seed (director-seeds.ts's
// `media`): short-lived links to a storyboard card and a preview clip per shot and a
// music track, while uploads are on. Opened on its own, any plan also says how each
// asset's default image is coming along (a seed's are made with its media). A plan names
// no storage path itself.
const mediaUrl = z.url().optional();
const servedShotSchema = shotSchema.extend({ storyboardUrl: mediaUrl, previewUrl: mediaUrl });
const servedAssetSchema = assetSchema.extend({
  /**
   * Its default image, drawn right after indexing: `making` until it's there, then a
   * short-lived link while it's `ready` and uploads are on; absent when none is made
   * (footage and sound, past the limits, or in the library).
   */
  image: z
    .object({ status: z.enum(["making", "ready", "failed"]), url: z.url().nullable() })
    .optional(),
});
export type ServedAsset = z.infer<typeof servedAssetSchema>;
const servedShotPlanSchema = shotPlanSchema.extend({
  shots: z.array(servedShotSchema).min(1).max(DIRECTOR_MAX_SHOTS),
  assets: z.array(servedAssetSchema).max(DIRECTOR_MAX_ASSETS).default([]),
  musicUrl: mediaUrl,
});
export type ServedShotPlan = z.infer<typeof servedShotPlanSchema>;

// A template a member describes (`director.create`): what they typed, their talk with
// Director (who asks at most DIRECTOR_MAX_QUESTIONS questions) and up to
// DIRECTOR_MAX_BRIEF_PHOTOS photos of theirs (ready `director-brief-photo` uploads).
export const DIRECTOR_BRIEF_MAX_LENGTH = 1_000;
const DIRECTOR_BRIEF_TURN_MAX_LENGTH = 500;
export const DIRECTOR_MAX_BRIEF_TURNS = 8;
export const DIRECTOR_MAX_BRIEF_PHOTOS = 4;
const DIRECTOR_MAX_QUESTIONS = 3;
const briefTurnSchema = z.object({
  role: z.enum(["member", "director"]),
  text: z.string().trim().min(1).max(DIRECTOR_BRIEF_TURN_MAX_LENGTH),
});
export type BriefTurn = z.infer<typeof briefTurnSchema>;
const briefSchema = z.object({
  text: z.string().trim().min(1).max(DIRECTOR_BRIEF_MAX_LENGTH),
  messages: z.array(briefTurnSchema).max(DIRECTOR_MAX_BRIEF_TURNS),
});
const briefInput = briefSchema.extend({
  photos: z.array(fileIdSchema).max(DIRECTOR_MAX_BRIEF_PHOTOS),
});
export type BriefInput = z.infer<typeof briefInput>;

/** Director's next turn while a member describes a template. */
const brainstormReplySchema = z.object({
  /** One or two sentences: a reaction and at most one question. */
  reply: z.string(),
  /** Enough is known to write the shots. */
  ready: z.boolean(),
  questionsLeft: z.number().int().min(0).max(DIRECTOR_MAX_QUESTIONS),
});
export type BrainstormReply = z.infer<typeof brainstormReplySchema>;

export const directorPlanSchema = z.object({
  id: directorPlanIdSchema,
  /**
   * The YouTube video's id; a created template's is a random id of the same shape, so
   * every route keyed by it works the same, and `source` says it's no YouTube video.
   */
  videoId: videoIdSchema,
  /**
   * A seeded template every workspace starts with, a short a member indexed, or one a
   * member described (`director.create`).
   */
  source: z.enum(["seed", "user", "created"]),
  /** What a created template was written from; absent on any other. */
  brief: briefSchema.nullable().optional(),
  /** pending → analyzing → ready (or failed, with an error code). */
  status: z.enum(["pending", "analyzing", "ready", "failed"]),
  /** How far indexing got, finer than `status`, for showing its progress. */
  stage: z.enum(["queued", "watching", "writing", "ready", "failed"]),
  error: z.string().nullable(),
  plan: servedShotPlanSchema.nullable(),
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

/** What Director points at on the camera, in its own words: "the window behind you". */
export const DIRECTOR_LOCATE_TARGET_MAX_LENGTH = 120;
/** A mark's label: two or three plain words. */
export const DIRECTOR_MARK_LABEL_MAX_LENGTH = 40;

/**
 * Where a thing Director named is in the frame it was looked for in: a box as fractions
 * of that frame from its top-left, with the thing named in plain words; or not found
 * (not in view, or Gemini wasn't sure), when nothing is drawn.
 */
export const locatedSchema = z.object({
  found: z.boolean(),
  label: z.string().min(1).max(DIRECTOR_MARK_LABEL_MAX_LENGTH),
  box: boxSchema.nullable(),
});
export type Located = z.infer<typeof locatedSchema>;

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
  /** Why it would or wouldn't be the one to use, in a line: shown under Director's pick. */
  reason: z.string().nullable(),
  /** The member chose it for its shot ("use the second one"): it beats Director's pick. */
  chosen: z.boolean(),
  /**
   * An attempt marked while shooting (or a take filmed), or one the post-session pass
   * found in the whole recording after Done, such as a line said while rehearsing.
   */
  origin: z.enum(["shoot", "pass"]),
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
  /** Director's pick: the best-scored take (the newest of a tie); null until one is scored. */
  pickedTakeId: directorTakeIdSchema.nullable(),
  /** The take the member chose for the shot while shooting, over Director's pick. */
  chosenTakeId: directorTakeIdSchema.nullable(),
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

/** A match cut's anchor: what stays on the same spot across the cut ("the watch"). */
const MATCH_CUT_ANCHOR_MAX_LENGTH = 120;
const takeMs = z
  .number()
  .int()
  .min(0)
  .max(DIRECTOR_MAX_SHOT_SECONDS * 1000);
/** One side of a match cut: a take of the caller's, and where in it the cut falls. */
const matchCutSideSchema = z.object({ takeId: directorTakeIdSchema, atMs: takeMs });

/** A match cut to line up: the two takes either side of it, and what stays put. */
const matchCutAskSchema = z.object({
  videoId: videoIdSchema,
  anchor: z.string().trim().min(1).max(MATCH_CUT_ANCHOR_MAX_LENGTH),
  outgoing: matchCutSideSchema,
  incoming: matchCutSideSchema,
});
export type MatchCutAsk = z.infer<typeof matchCutAskSchema>;

/**
 * A match cut lined up (the redesign spec's 9.5): where to end the outgoing take and
 * start the incoming one, and how to draw the incoming one so the anchor stays put:
 * scaled `scale` and turned `rotation` degrees clockwise about the frame's centre, then
 * moved `x`, `y` pixels of the finished 720x1280 frame. `not-found`: the anchor wasn't
 * seen in both, and the cut stays a plain cut. The offsets are what "Check the cut"
 * shows, in pixels of the finished frame; the frames are JPEGs (base64) either side of
 * the cut, the incoming one already aligned.
 */
export const matchCutAlignmentSchema = z.object({
  status: z.enum(["aligned", "not-found"]),
  outgoingEndMs: takeMs,
  incomingStartMs: takeMs,
  transform: z.object({
    x: z.number().min(-720).max(720),
    y: z.number().min(-1280).max(1280),
    scale: z.number().min(0.25).max(4),
    rotation: z.number().min(-180).max(180),
  }),
  offsetBeforePx: z.number().min(0),
  offsetPx: z.number().min(0),
  scaleDiff: z.number().min(0),
  rotationDiff: z.number().min(0),
  cropPercent: z.number().min(0).max(100),
  withinTolerance: z.boolean(),
  anchor: z.object({ x: fraction, y: fraction }).nullable(),
  outgoingFrame: z.string().nullable(),
  incomingFrame: z.string().nullable(),
});
export type MatchCutAlignment = z.infer<typeof matchCutAlignmentSchema>;

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
   * Where something Director names is in one camera frame (the 9:16 crop the member sees,
   * unmirrored), for a mark pinned to it on the shoot screen. A model call each time:
   * Director's marks re-locate at most every two seconds, so this allows a few marks'
   * worth with room to spare.
   */
  locate: route("POST", "/director/locate", "Find something in a camera frame")
    .meta({ rateLimit: { name: "director-locate", points: 60, windowSeconds: 60, per: "user" } })
    .input(
      z.object({
        target: z.string().trim().min(1).max(DIRECTOR_LOCATE_TARGET_MAX_LENGTH),
        image: z.string().min(DIRECTOR_FRAME_MIN_LENGTH).max(DIRECTOR_FRAME_MAX_LENGTH),
      }),
    )
    .output(locatedSchema),
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
  /**
   * Chooses one of the caller's takes for its shot, over Director's pick, or (with no
   * take) goes back to Director's pick (DIRECTOR_TAKE_NOT_FOUND unless it's the caller's
   * take of that shot). Answers with every shot, as `shots` does.
   */
  chooseTake: route("POST", "/director/{videoId}/choices", "Choose a take for a shot")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ videoId: videoIdSchema, shotIndex, takeId: directorTakeIdSchema.nullable() }))
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
  /**
   * Lines up a match cut between two of the caller's video takes of the short
   * (DIRECTOR_TAKE_NOT_FOUND unless both are theirs, ready and videos): Gemini finds the
   * anchor either side of the cut and the AI service works out where to cut and how to
   * move the incoming take so it stays put. Nothing is stored: the editor asks again.
   */
  alignMatchCut: route("POST", "/director/{videoId}/match-cuts", "Line up a match cut")
    .meta({
      rateLimit: { name: "director-match-cuts", points: 60, windowSeconds: HOUR_S, per: "user" },
    })
    .input(matchCutAskSchema)
    .output(matchCutAlignmentSchema),
  /** Every cut of the caller's, newest first (the client groups them by template). */
  media: route("GET", "/media", "Your cuts").output(z.array(directorCutSchema)),
  /**
   * Director's next turn while the member describes a template of their own: a reaction
   * and at most one question (at most DIRECTOR_MAX_QUESTIONS in all), or ready to write.
   * Photos are ready `director-brief-photo` uploads of the caller's (FILE_NOT_FOUND,
   * FILE_NOT_READY). A model call each time.
   */
  brainstorm: route("POST", "/director/created/turns", "Talk your idea through with Director")
    .meta({
      rateLimit: { name: "director-brainstorm", points: 40, windowSeconds: HOUR_S, per: "user" },
    })
    .input(briefInput)
    .output(brainstormReplySchema),
  /**
   * A template of the member's own from their brief, queued to be written like an
   * indexed short (watch `stage`): its own id, counted apart from their one indexed short,
   * a few a day (DIRECTOR_CREATE_LIMIT).
   */
  create: route("POST", "/director/created", "Describe your own")
    .meta({
      rateLimit: { name: "director-create", points: 10, windowSeconds: HOUR_S, per: "user" },
    })
    .input(briefInput)
    .output(directorPlanSchema),
  /**
   * Saves the member's changes to the shots of a template they described: edited,
   * reordered, added or deleted (DIRECTOR_PLAN_NOT_EDITABLE for anyone else's, or an
   * indexed one; DIRECTOR_PLAN_NOT_READY before it's written). Shots are put back to back.
   */
  editPlan: route("POST", "/director/{videoId}/plan", "Change your template's shots")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ videoId: videoIdSchema, plan: shotPlanSchema }))
    .output(directorPlanSchema),
};
