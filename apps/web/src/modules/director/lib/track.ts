/**
 * The editor's timeline: how wide a second is, the ruler's ticks, the clock's reading,
 * and a take's sound as the bars of a waveform.
 */

/** How wide a second of the edit is on the timeline, in CSS pixels. */
export const PX_PER_SECOND = 64;

/** "00:07", minutes and seconds, as the editor's clock reads. */
export function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds + 1e-6));
  const minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export interface Tick {
  seconds: number;
  /** Whole seconds are labelled; the half seconds between are a mark. */
  label: boolean;
}

/** A tick every half second from 0 to `total`, rounded up to the next whole second. */
export function rulerTicks(total: number): Tick[] {
  const halves = Math.ceil(Math.max(0, total)) * 2;
  return Array.from({ length: halves + 1 }, (_, at) => ({
    seconds: at / 2,
    label: at % 2 === 0,
  }));
}

/**
 * The loudness of `samples` between `from` and `to` seconds, as `count` bars from 0 to 1
 * (each bar the loudest sample in its slice, against the loudest of all).
 */
export function peaks(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  count: number,
): number[] {
  const first = Math.max(0, Math.floor(from * sampleRate));
  const last = Math.min(samples.length, Math.ceil(to * sampleRate));
  const slice = Math.max(1, Math.floor((last - first) / Math.max(1, count)));
  const bars = Array.from({ length: Math.max(0, count) }, (_, bar) =>
    samples
      .subarray(first + bar * slice, Math.min(last, first + (bar + 1) * slice))
      .reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0),
  );
  const top = Math.max(...bars, 0);
  return top > 0 ? bars.map((bar) => bar / top) : bars;
}
