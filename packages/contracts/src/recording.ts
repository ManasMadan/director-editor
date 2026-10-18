/**
 * Director's continuous recording (the roll): from "Start shooting" until Done the shoot
 * screen records everything, in ten-second slices it uploads straight to storage as it
 * goes. Director marks each attempt at a shot (`mark`), and every attempt is cut out of
 * the footage as its own take.
 *
 * The limits and rules here are shared by the API (which signs each slice's upload), the
 * worker (which sends an attempt's footage to the clipper) and the browser (which records
 * and queues the slices).
 *
 * Times are a part's own clock: milliseconds of media since that part's recording began,
 * as its recorder's timestamps count them. A part is one run of the browser's
 * MediaRecorder: flipping the camera starts a new one (a recorder can't switch tracks),
 * and so does coming back after the browser stopped it (the tab hidden, the phone locked).
 */
import { MINUTE_MS, SECOND_MS } from "./time";

/** What MediaRecorder records: WebM in Chromium and Firefox, MP4 in Safari. */
export const RECORDING_TYPES = ["video/webm", "video/mp4"] as const;
export type RecordingType = (typeof RECORDING_TYPES)[number];

/** A slice's longest: the recorder's ten-second timeslice drifts, and a part's last runs on. */
export const RECORDING_SLICE_MAX_MS = 15 * SECOND_MS;
/**
 * A slice's largest. The recorder aims at about 1.5 Mbit/s, so ten seconds are about
 * 2 MB; this leaves room for Safari's higher bitrates and a busy picture.
 */
export const RECORDING_SLICE_MAX_BYTES = 8_000_000;
/** A session records at most 20 minutes (pauses don't count), with a warning at 17. */
export const RECORDING_MAX_MS = 20 * MINUTE_MS;
export const RECORDING_WARN_MS = 17 * MINUTE_MS;
/** The furthest any time in a part can be: the session's whole length, and some slack. */
export const RECORDING_PART_MAX_MS = RECORDING_MAX_MS + MINUTE_MS;
/**
 * The bitrate no recording reaches (eight megabytes in ten seconds): a slice is counted
 * as lasting at least as long as its size takes at this rate, whatever its declared
 * duration, so the 20 minutes can't be dodged by declaring short slices.
 */
export const RECORDING_MAX_BITS_PER_SECOND = 6_400_000;
/** Attempts in a session: far more than 20 minutes hold. */
export const RECORDING_MAX_ATTEMPTS = 1_000;
/** Parts in a session: each camera flip or comeback starts one. */
export const RECORDING_MAX_PARTS = 60;
/** Slices in a part: the session's 20 minutes at ten seconds a slice, and some slack. */
export const RECORDING_MAX_SLICES_PER_PART = 150;
/**
 * A member's raw footage, across their sessions: past it, nothing more records until an
 * older session is deleted (the shoot screen offers the oldest).
 */
export const RECORDING_FOOTAGE_MAX_BYTES = 1_000_000_000;
/**
 * How long raw footage is kept: 7 days after the last video saved from it, 14 days at
 * most; the demo account's 24 hours. Takes cut from it are kept with the member's videos.
 */
export const RECORDING_KEEP_DAYS = 7;
export const RECORDING_KEEP_MAX_DAYS = 14;
export const RECORDING_DEMO_KEEP_HOURS = 24;
/**
 * Footage past an attempt's end the clipper is given, so snapping can move the end onto
 * the last word (by up to 1.5 seconds, plus a quarter-second pad).
 */
const RECORDING_SNAP_MARGIN_MS = 2 * SECOND_MS;

/** A slice of a part, as far as choosing footage goes. */
export interface FootageSlice {
  index: number;
  startMs: number;
  durationMs: number;
  uploaded: boolean;
}

/**
 * The last slice of a part an attempt ending at `endMs` needs, once every slice up to it
 * is uploaded; null while one is still to come. Footage is played from the part's first
 * slice (only it holds the recording's header), so the slices needed are always the
 * first ones, without a gap.
 *
 * `endMs` null is an attempt still open when its part ended: it runs to the part's end.
 * `sliceCount` is how many slices the part has once its recorder stopped (null while it
 * records): an attempt ending past the footage gets all of it.
 */
export function footageThrough(
  slices: readonly FootageSlice[],
  endMs: number | null,
  sliceCount: number | null,
): number | null {
  const byIndex = new Map(slices.map((slice) => [slice.index, slice]));
  const last = sliceCount === null ? RECORDING_MAX_SLICES_PER_PART : sliceCount;
  for (let index = 0; index < last; index++) {
    const slice = byIndex.get(index);
    if (!slice?.uploaded) {
      return null;
    }
    if (endMs !== null && slice.startMs + slice.durationMs >= endMs + RECORDING_SNAP_MARGIN_MS) {
      return index;
    }
  }
  return sliceCount === null || sliceCount === 0 ? null : sliceCount - 1;
}

/**
 * How long the server counts a slice as lasting: its declared duration, or longer when
 * its size couldn't have been recorded in that time.
 */
export function countedMs(slice: { durationMs: number; size: number }) {
  return Math.max(
    slice.durationMs,
    Math.ceil((slice.size * 8_000) / RECORDING_MAX_BITS_PER_SECOND),
  );
}

/**
 * The shoot screen's upload queue holds at most this much footage: past it the screen
 * pauses recording until the queue catches up (a phone short of storage, a dead network).
 */
export const RECORDING_QUEUE_MAX_MS = 5 * MINUTE_MS;

/**
 * Whether `head` (a part's first bytes) starts the way a recorder's `type` does: WebM's
 * EBML header, or an MP4's `ftyp` box. Footage is only ever decoded as its part's type,
 * and a first slice that isn't one isn't kept.
 */
export function looksLikeRecording(head: Uint8Array, type: RecordingType) {
  if (type === "video/webm") {
    return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }
  return String.fromCharCode(...head.subarray(4, 8)) === "ftyp";
}

/** Where a slice's bytes are stored. */
export const recordingSliceKey = (sessionId: string, partIndex: number, index: number) =>
  `recordings/${sessionId}/${partIndex}/${index}`;
