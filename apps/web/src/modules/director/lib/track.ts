/** The editor's clock reading, and how wide each shot's column is on its board. */

/** How wide a second of the edit is on the board, in CSS pixels. */
const PX_PER_SECOND = 64;
/**
 * A column is as wide as its shot is long, within bounds: from about two seconds up the
 * board reads as time, a shorter shot still has room to tap its takes and stepper, and a
 * long one doesn't push the next shot off a phone's screen.
 */
const MIN_COLUMN_PX = 120;
const MAX_COLUMN_PX = 360;

export function columnWidth(seconds: number): number {
  return Math.round(Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, seconds * PX_PER_SECOND)));
}

/** "00:07", minutes and seconds, as the editor's clock reads. */
export function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds + 1e-6));
  const minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
