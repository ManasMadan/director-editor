/**
 * Director live's debug log on this device: the timing of the last turns' voice and
 * captions, kept in memory and never sent anywhere (no words, only figures). On a phone,
 * read it from the browser's remote inspector (Safari's Web Inspector, Chrome's
 * chrome://inspect) by calling `directorLiveTimings()` in the console, to see how far the
 * transcript trails the audio on that phone and network; the relay logs Gemini's side of
 * the same gap ("live turn", captionLagMs).
 */
import type { TurnTiming } from "./voice-clock";

/** Enough turns for a few minutes of shooting. */
const KEPT = 50;

export interface TimingEntry extends TurnTiming {
  /** When the turn ended, on the page's clock (performance.now). */
  at: number;
}

const timings: TimingEntry[] = [];

/** Keeps a turn's timing, dropping the oldest past KEPT. */
export function logTurnTiming(timing: TurnTiming, at: number) {
  timings.push({ ...timing, at });
  timings.splice(0, Math.max(0, timings.length - KEPT));
}

/** The kept turns' timing, oldest first. */
export function turnTimings(): TimingEntry[] {
  return [...timings];
}

if (typeof window !== "undefined") {
  Object.assign(window, { directorLiveTimings: turnTimings });
}
