/**
 * When to stop the recorder after the video's last frame. MediaRecorder encodes the
 * picture in real time, and on a busy phone or computer its encoder falls behind; when it
 * stops, the frames it hasn't encoded yet are dropped (the sound, cheap to encode, is all
 * there), which is how a saved video ended 18 seconds before its sound. Nothing says when
 * the encoder has caught up, so the render watches the recording grow (lib/recorded.ts):
 * the picture written so far, checked every so often.
 *
 * The recorder writes the picture in pieces (an MP4 fragment, a few seconds long), the
 * last of which is only written when it stops. So it can stop once the picture is all
 * there; or once only that last piece is missing and the encoder has had time to encode
 * it at the pace it's been keeping (or a few seconds, when it hasn't moved since the
 * end). The render gives up waiting at its cap either way, and checks the file after.
 */

/** The picture written so far (seconds), at a moment of the wait (milliseconds). */
export interface Written {
  at: number;
  picture: number;
}

/** How long the picture may stay put before the last piece counts as waiting for the stop. */
export const STALL_MS = 3000;
/** The longest a piece is taken to be until a longer one is seen. */
const PIECE_SECONDS = 4;

/** How much more picture each second of waiting writes, from the first piece to the last. */
function pace(advances: readonly Written[]) {
  const first = advances[0];
  const last = advances.at(-1);
  if (!first || !last || last.at === first.at) {
    return null;
  }
  return (last.picture - first.picture) / (last.at - first.at);
}

/** The checks where the picture grew, in order. */
function advancesOf(checks: readonly Written[]) {
  const advances: Written[] = [];
  for (const check of checks) {
    const before = advances.at(-1)?.picture ?? 0;
    if (check.picture > before) {
      advances.push(check);
    }
  }
  return advances;
}

/**
 * Whether the encoder has caught up enough to stop the recorder, from the checks so far
 * (oldest first): `expected` seconds of picture are due, `frame` seconds is one frame.
 */
export function caughtUp(checks: readonly Written[], expected: number, frame: number): boolean {
  const last = checks.at(-1);
  if (!last) {
    return false;
  }
  if (last.picture >= expected - frame) {
    return true;
  }
  const advances = advancesOf(checks);
  const steps = advances.map(
    (advance, index) => advance.picture - (advances[index - 1]?.picture ?? 0),
  );
  const piece = Math.max(PIECE_SECONDS, ...steps.slice(1));
  if (last.picture < expected - piece) {
    return false;
  }
  // Since the picture last grew, or since the wait began when it hasn't grown at all.
  const since = last.at - (advances.at(-1)?.at ?? Math.min(...checks.map((check) => check.at)));
  const rate = pace(advances);
  const remaining = rate ? (expected - last.picture) / rate : 0;
  return since >= Math.max(STALL_MS, remaining);
}
