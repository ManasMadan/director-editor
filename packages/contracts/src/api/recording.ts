/**
 * Director's continuous recording (the roll; the rules are in ../recording.ts). A session
 * runs from "Start shooting" to Done on one plan, and is the member's own:
 *
 *   1. `start` opens it, `addPart` starts each run of the recorder (the first, and one per
 *      camera flip or comeback), and `closePart` says how many slices a run made.
 *   2. Each slice: `uploadSlice` signs a PUT for exactly that slice, the browser sends the
 *      bytes straight to storage, then `completeSlice`. Nothing passes through the API.
 *   3. `mark` records where Director says an attempt at a shot starts and ends; an ended
 *      attempt is cut out of the footage as its own take once its slices are uploaded.
 *      `pause` and `resume` record the stretches nothing was recorded, which no attempt
 *      ever spans.
 *   4. `finish` is Done. Slices still queued in the browser may upload after it.
 *
 * Raw footage is deleted on a schedule (RECORDING_KEEP_DAYS), or at once with `remove`,
 * which deletes the session's takes too.
 */
import * as z from "zod";
import {
  directorTakeIdSchema,
  fileIdSchema,
  recordingAttemptIdSchema,
  recordingSessionIdSchema,
  videoIdSchema,
} from "../ids";
import {
  RECORDING_MAX_ATTEMPTS,
  RECORDING_MAX_PARTS,
  RECORDING_MAX_SLICES_PER_PART,
  RECORDING_PART_MAX_MS,
  RECORDING_SLICE_MAX_BYTES,
  RECORDING_SLICE_MAX_MS,
  RECORDING_TYPES,
} from "../recording";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";
import { DIRECTOR_MAX_SHOTS } from "./director";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_SHOT_NOT_FOUND",
  "RECORDING_NOT_FOUND",
  "RECORDING_FINISHED",
  "RECORDING_LIMIT_REACHED",
  "RECORDING_STORAGE_FULL",
  "RECORDING_PAUSED",
  "RECORDING_PART_NOT_FOUND",
  "RECORDING_PART_CLOSED",
  "RECORDING_SLICE_NOT_UPLOADED",
  "RECORDING_ATTEMPT_NOT_OPEN",
  "RECORDING_MARK_OUT_OF_ORDER",
  "RECORDING_SLICE_INVALID",
  "DEMO_ACCOUNT_LOCKED",
);

/** A line of the shot an attempt is at, as Director names it. */
const RECORDING_LINE_MAX_LENGTH = 500;
/** Director's view of how an attempt went, in a few words. */
const RECORDING_NOTE_MAX_LENGTH = 300;

const msInPart = z.int32().min(0).max(RECORDING_PART_MAX_MS);
const partIndex = z
  .int32()
  .min(0)
  .max(RECORDING_MAX_PARTS - 1);
const sliceIndex = z
  .int32()
  .min(0)
  .max(RECORDING_MAX_SLICES_PER_PART - 1);
const shotIndex = z
  .int32()
  .min(0)
  .max(DIRECTOR_MAX_SHOTS - 1);
/** An attempt's number in its session, which the shoot screen gives it: 1, 2, 3... */
const attemptNumber = z.int32().min(1).max(RECORDING_MAX_ATTEMPTS);

export const recordingSessionSchema = z.object({
  id: recordingSessionIdSchema,
  videoId: videoIdSchema,
  /** Recording until Done (`finish`). */
  status: z.enum(["recording", "done"]),
  /** A pause is open: nothing records, and no attempt can start, until a touch resumes. */
  paused: z.boolean(),
  /** Footage uploaded so far: what counts against the session's 20 minutes. */
  recordedMs: z.number().int().nonnegative(),
  /** Its size: what counts against the member's footage allowance. */
  bytes: z.number().int().nonnegative(),
  createdAt: z.date(),
  finishedAt: z.date().nullable(),
  /** When its raw footage is deleted. */
  expiresAt: z.date(),
});
export type RecordingSession = z.infer<typeof recordingSessionSchema>;

export const recordingPartSchema = z.object({
  index: partIndex,
  camera: z.enum(["front", "back"]),
  contentType: z.enum(RECORDING_TYPES),
  /** How many slices the run made, once its recorder stopped (null while it records). */
  sliceCount: z.number().int().nonnegative().nullable(),
  /** The slices stored so far, by index: what a reopened shoot screen needn't send again. */
  uploaded: z.array(z.number().int().nonnegative()),
});
export type RecordingPart = z.infer<typeof recordingPartSchema>;

export const recordingAttemptSchema = z.object({
  id: recordingAttemptIdSchema,
  /** 1 for the session's first attempt, at any shot. */
  number: z.number().int().positive(),
  shotIndex,
  partIndex,
  line: z.string().nullable(),
  note: z.string().nullable(),
  /** Where Director marked it, in its part's clock. */
  startMs: z.number().int().nonnegative(),
  /** Null while it's open (or when its part ended first: it runs to the part's end). */
  endMs: z.number().int().nonnegative().nullable(),
  /**
   * open: started; waiting: ended, its footage still uploading; clipping: at the clipper;
   * clipped: a take (`takeId`); failed: it couldn't be cut (`error`).
   */
  status: z.enum(["open", "waiting", "clipping", "clipped", "failed"]),
  /** Where the take was cut, once clipped: the marks snapped to the first and last words. */
  clip: z
    .object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
    .nullable(),
  takeId: directorTakeIdSchema.nullable(),
  /** The take's video (a `director-take-video` file of the member's). */
  fileId: fileIdSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.date(),
});
export type RecordingAttempt = z.infer<typeof recordingAttemptSchema>;

const recordingSessionDetailSchema = recordingSessionSchema.extend({
  parts: z.array(recordingPartSchema),
  /** In the order they started. */
  attempts: z.array(recordingAttemptSchema),
});
export type RecordingSessionDetail = z.infer<typeof recordingSessionDetailSchema>;

const sessionInput = z.object({ sessionId: recordingSessionIdSchema });

const route = (method: "GET" | "POST" | "DELETE", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Recording"], summary });

export const recordingContract = {
  /**
   * Starts recording a ready plan (DIRECTOR_PLAN_NOT_READY before then), unless the
   * member's raw footage is at its allowance (RECORDING_STORAGE_FULL). Not on the shared
   * demo account (DEMO_ACCOUNT_LOCKED): everyone on it would see everyone's footage.
   * The member's session of the short still recording (a tab closed before Done) is
   * answered instead, its parts and attempts included, for the shoot screen to carry on.
   */
  start: route("POST", "/recording/sessions", "Start recording a short")
    .meta({
      rateLimit: { name: "recording-sessions", points: 30, windowSeconds: HOUR_S, per: "user" },
    })
    .input(z.object({ videoId: videoIdSchema }))
    .output(recordingSessionDetailSchema),
  /** The member's sessions whose footage is still kept, newest first. */
  sessions: route("GET", "/recording/sessions", "Your recording sessions").output(
    z.array(recordingSessionSchema),
  ),
  /** One of the member's sessions, with its parts and attempts (RECORDING_NOT_FOUND). */
  session: route("GET", "/recording/sessions/{sessionId}", "A recording session")
    .input(sessionInput)
    .output(recordingSessionDetailSchema),
  /**
   * Starts a run of the recorder: the first, or one after a camera flip or a comeback.
   * Sending the same part again is fine; a different camera or type for an index in use is
   * RECORDING_PART_CLOSED.
   */
  addPart: route("POST", "/recording/sessions/{sessionId}/parts", "Start a part")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      sessionInput.extend({
        index: partIndex,
        camera: z.enum(["front", "back"]),
        contentType: z.enum(RECORDING_TYPES),
      }),
    )
    .output(recordingPartSchema),
  /** The recorder stopped: the part has `sliceCount` slices and no more. */
  closePart: route("POST", "/recording/sessions/{sessionId}/parts/{index}/close", "End a part")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      sessionInput.extend({
        index: partIndex,
        sliceCount: z.int32().min(0).max(RECORDING_MAX_SLICES_PER_PART),
      }),
    )
    .output(recordingPartSchema),
  /**
   * Signs the upload of one slice: PUT its bytes to `upload.url` with exactly
   * `upload.headers`. Null when it's already stored. A slice past the session's 20
   * minutes is RECORDING_LIMIT_REACHED, past the member's allowance
   * RECORDING_STORAGE_FULL. The minutes count what the server makes of the slice: its
   * duration, or longer when its size couldn't have been recorded in less
   * (RECORDING_MAX_BITS_PER_SECOND). Allowed after Done, so a queue left behind can
   * finish.
   */
  uploadSlice: route("POST", "/recording/sessions/{sessionId}/slices", "Upload a slice")
    .meta({
      rateLimit: {
        name: "recording-slice-uploads",
        points: 600,
        windowSeconds: HOUR_S,
        per: "user",
      },
    })
    .input(
      sessionInput.extend({
        partIndex,
        index: sliceIndex,
        startMs: msInPart,
        durationMs: z.int32().min(1).max(RECORDING_SLICE_MAX_MS),
        size: z.int32().min(1).max(RECORDING_SLICE_MAX_BYTES),
      }),
    )
    .output(
      z.object({
        upload: z
          .object({
            url: z.url(),
            headers: z.record(z.string(), z.string()),
            expiresAt: z.date(),
          })
          .nullable(),
      }),
    ),
  /**
   * After the PUT: the slice is stored (RECORDING_SLICE_NOT_UPLOADED until it is), and any
   * ended attempt it was the last footage for goes to the clipper. A part's first slice
   * must start the way its recorder's files do (RECORDING_SLICE_INVALID, and it's
   * deleted, when it doesn't).
   */
  completeSlice: route(
    "POST",
    "/recording/sessions/{sessionId}/slices/complete",
    "Finish a slice's upload",
  )
    .meta({
      rateLimit: {
        name: "recording-slice-completes",
        points: 600,
        windowSeconds: HOUR_S,
        per: "user",
      },
    })
    .input(sessionInput.extend({ partIndex, index: sliceIndex }))
    .output(recordingSessionSchema),
  /**
   * Director's mark: attempt `attempt` at a shot starts or ends, at `atMs` in the part's
   * clock. The shoot screen numbers attempts 1, 2, 3... (a reopened one carries on from
   * the session's last), so a mark sent again names the attempt it was for: the same
   * start or end again answers that attempt, and never touches a newer one. A start ends
   * the open attempt there; a start numbered below the session's last is
   * RECORDING_MARK_OUT_OF_ORDER; an end for an attempt that isn't open (or never
   * started) is RECORDING_ATTEMPT_NOT_OPEN. Never while paused (RECORDING_PAUSED).
   */
  mark: route("POST", "/recording/sessions/{sessionId}/marks", "Mark an attempt")
    .meta({
      rateLimit: { name: "recording-marks", points: 600, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      sessionInput.extend({
        event: z.enum(["start", "end"]),
        attempt: attemptNumber,
        shotIndex,
        partIndex,
        atMs: msInPart,
        line: z.string().trim().min(1).max(RECORDING_LINE_MAX_LENGTH).optional(),
        note: z.string().trim().min(1).max(RECORDING_NOTE_MAX_LENGTH).optional(),
      }),
    )
    .output(recordingAttemptSchema),
  /**
   * Recording paused at `atMs`: an open attempt ends there, and nothing from the pause to
   * the resume is ever clipped. Pausing twice is fine.
   */
  pause: route("POST", "/recording/sessions/{sessionId}/pauses", "Pause recording")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(sessionInput.extend({ partIndex, atMs: msInPart }))
    .output(recordingSessionSchema),
  /**
   * Recording resumed (only ever from a touch on the shoot screen): at `atMs` in the same
   * part, or in a new part when the recorder had to start again.
   */
  resume: route("POST", "/recording/sessions/{sessionId}/resumes", "Resume recording")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(sessionInput.extend({ partIndex, atMs: msInPart }))
    .output(recordingSessionSchema),
  /** Done: an open attempt runs to its part's end, and the session records nothing more. */
  finish: route("POST", "/recording/sessions/{sessionId}/finish", "Finish recording")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(sessionInput)
    .output(recordingSessionSchema),
  /** Deletes the session now: its raw footage, and the takes cut from it. */
  remove: route("DELETE", "/recording/sessions/{sessionId}", "Delete a recording session")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(sessionInput)
    .output(z.object({ removed: z.literal(true) })),
};
