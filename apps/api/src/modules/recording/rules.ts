/**
 * The recording module's rules that need nothing but their inputs: when footage is
 * deleted, where an attempt ends, which ended attempts have all their footage, and how a
 * row is served.
 */
import {
  type RecordingAttempt,
  type RecordingPart,
  type RecordingSession,
  recordingAttemptSchema,
  recordingPartSchema,
  recordingSessionSchema,
} from "@repo/contracts/api";
import {
  footageThrough,
  RECORDING_DEMO_KEEP_HOURS,
  RECORDING_KEEP_DAYS,
} from "@repo/contracts/recording";
import { DAY_S, HOUR_MS, SECOND_MS } from "@repo/contracts/time";

const DAY_MS = DAY_S * SECOND_MS;

/**
 * When a new session's raw footage is deleted: 7 days on (a saved video keeps it longer,
 * up to 14: RecordingRepository.keep), or the demo account's 24 hours.
 */
export function expiresAt(now: Date, demo: boolean): Date {
  const keepMs = demo ? RECORDING_DEMO_KEEP_HOURS * HOUR_MS : RECORDING_KEEP_DAYS * DAY_MS;
  return new Date(now.getTime() + keepMs);
}

/**
 * Where an attempt open since `startMs` in part `attemptPart` ends when it's ended at
 * `atMs` in part `atPart`: there, or at its own part's end (null) when the recorder
 * moved on to another part since. A clock that went back (an end before the start) ends
 * it where it started, which the clipper refuses rather than cutting a guess.
 */
export function endOf(
  attempt: { partIndex: number; startMs: number },
  at: { partIndex: number; atMs: number },
): number | null {
  if (at.partIndex !== attempt.partIndex) {
    return null;
  }
  return Math.max(at.atMs, attempt.startMs);
}

interface FootagePart {
  index: number;
  sliceCount: number | null;
  slices: readonly { index: number; startMs: number; durationMs: number; status: string }[];
}

/**
 * The ended attempts all of whose footage is stored, ready for the clipper. A part that
 * ended with no slices at all is ready too: there's nothing more to wait for, and the
 * clipper fails the attempt.
 */
export function readyAttempts<A extends { partIndex: number; endMs: number | null }>(
  attempts: readonly A[],
  parts: readonly FootagePart[],
): A[] {
  const byIndex = new Map(parts.map((part) => [part.index, part]));
  return attempts.filter((attempt) => {
    const part = byIndex.get(attempt.partIndex);
    if (!part) {
      return false;
    }
    if (part.sliceCount === 0) {
      return true;
    }
    const slices = part.slices.map((slice) => ({
      ...slice,
      uploaded: slice.status === "uploaded",
    }));
    return footageThrough(slices, attempt.endMs, part.sliceCount) !== null;
  });
}

/** A session as the contract serves it: `pauses` holds its open pause, if any. */
export function toSession(row: {
  pauses: readonly unknown[];
  [field: string]: unknown;
}): RecordingSession {
  return recordingSessionSchema.parse({ ...row, paused: row.pauses.length > 0 });
}

export function toPart(row: FootagePart & { camera: string; contentType: string }): RecordingPart {
  return recordingPartSchema.parse({
    ...row,
    uploaded: row.slices.filter((slice) => slice.status === "uploaded").map((slice) => slice.index),
  });
}

export function toAttempt(row: {
  clipStartMs: number | null;
  clipEndMs: number | null;
  [field: string]: unknown;
}): RecordingAttempt {
  const { clipStartMs, clipEndMs, ...attempt } = row;
  const clip =
    clipStartMs === null || clipEndMs === null ? null : { startMs: clipStartMs, endMs: clipEndMs };
  return recordingAttemptSchema.parse({ ...attempt, clip });
}
