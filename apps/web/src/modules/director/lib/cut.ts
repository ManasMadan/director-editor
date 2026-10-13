/**
 * The Director's Cut: the take's first review, the instant it's recorded, from what the
 * phone measured while it ran (how much the camera moved, the light, how loud the voice
 * was) and how the setup stood when recording began. It picks the steadiest stretch of
 * the shot's length to loop, a score, the one thing that went best and the one thing to
 * try next. Gemini's own review (the take's `feedback`) follows once the take is sent.
 *
 * The weights are judgement, not measurement: they rank what a director would fix first
 * (a shot too short to use, then bad light, then shake, then framing).
 */
import type { Light } from "./frame-stats";
import { SHAKY } from "./frame-stats";

export interface Sample {
  /** Seconds from the start of the take. */
  seconds: number;
  /** How much the picture changed since the last sample (frame-stats `difference`). */
  motion: number;
  light: Light;
  /** The voice's level (RMS, 0 to 1), or null when the take records no sound. */
  loudness: number | null;
}

export interface Setup {
  kind: "video" | "photo";
  /** The shot's length in the edit. */
  length: number;
  /** How things stood when recording began; null when the shot doesn't judge it. */
  framed: boolean | null;
  angled: boolean | null;
  posed: boolean | null;
}

type Praise = "framing" | "steady" | "light" | "energy" | "pose" | "effort";
type Tip =
  | "longer"
  | "too-dark"
  | "too-bright"
  | "backlit"
  | "steady"
  | "framing"
  | "energy"
  | "angle"
  | "pose";

export interface Cut {
  startSeconds: number;
  endSeconds: number;
  score: number;
  praise: Praise;
  /** Null when there's nothing to fix: ship it. */
  tip: Tip | null;
  /** The usable part began late: the member needed longer to get set after "Action!". */
  lateStart: boolean;
}

/** The usable part starting after this many seconds counts as a late start. */
const LATE_START_SECONDS = 1.5;
/** A voice this quiet (RMS) reads as flat on a phone's speaker. */
const QUIET = 0.03;
/** A take shorter than this share of the shot leaves the edit short. */
const SHORT_SHARE = 0.85;

function mean(values: readonly number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mostCommon(lights: readonly Light[]): Light {
  const counts = new Map<Light, number>();
  for (const light of lights) {
    counts.set(light, (counts.get(light) ?? 0) + 1);
  }
  let best: Light = "good";
  let most = 0;
  for (const [light, count] of counts) {
    if (count > most) {
      best = light;
      most = count;
    }
  }
  return best;
}

/** The steadiest, best-lit stretch of `length` seconds (the earliest of equals). */
function bestWindow(samples: readonly Sample[], length: number) {
  const duration = samples.at(-1)?.seconds ?? 0;
  const window = Math.min(length, duration);
  let best = { start: 0, cost: Number.POSITIVE_INFINITY };
  for (const sample of samples) {
    if (sample.seconds + window > duration + 1e-6) {
      break;
    }
    const inside = samples.filter(
      (each) => each.seconds >= sample.seconds && each.seconds <= sample.seconds + window,
    );
    const darkShare = inside.filter((each) => each.light !== "good").length / inside.length;
    const cost = mean(inside.map((each) => each.motion)) + darkShare * 0.15;
    if (cost < best.cost - 1e-9) {
      best = { start: sample.seconds, cost };
    }
  }
  const inside = samples.filter(
    (each) => each.seconds >= best.start && each.seconds <= best.start + window,
  );
  return { start: best.start, end: best.start + window, inside, duration };
}

interface Reading {
  shake: number;
  light: Light;
  quiet: boolean;
  short: boolean;
}

/** What went best: the first strength a director would call out. */
function praiseOf(reading: Reading, setup: Setup): Praise {
  if (setup.framed === true) {
    return "framing";
  }
  if (reading.shake < 0.5) {
    return "steady";
  }
  if (reading.light === "good") {
    return "light";
  }
  if (!reading.quiet) {
    return "energy";
  }
  return setup.posed === true ? "pose" : "effort";
}

/** The one thing to try next, most important first. */
function tipOf(reading: Reading, setup: Setup): Tip | null {
  if (reading.short) {
    return "longer";
  }
  if (reading.light !== "good") {
    return reading.light;
  }
  if (reading.shake >= 1) {
    return "steady";
  }
  if (setup.framed === false) {
    return "framing";
  }
  if (reading.quiet) {
    return "energy";
  }
  if (setup.angled === false) {
    return "angle";
  }
  return setup.posed === false ? "pose" : null;
}

function scoreOf(reading: Reading, setup: Setup) {
  const penalties = [
    Math.min(2, reading.shake) * 12,
    reading.light === "good" ? 0 : 12,
    setup.framed === false ? 12 : 0,
    setup.angled === false ? 6 : 0,
    setup.posed === false ? 6 : 0,
    reading.quiet ? 10 : 0,
    reading.short ? 10 : 0,
  ];
  return Math.round(Math.max(35, Math.min(99, 97 - penalties.reduce((a, b) => a + b, 0))));
}

export function directorsCut(samples: readonly Sample[], setup: Setup): Cut {
  const window =
    setup.kind === "photo" || samples.length < 2
      ? { start: 0, end: setup.length, inside: samples, duration: setup.length }
      : bestWindow(samples, setup.length);
  const loud = window.inside.flatMap((sample) =>
    sample.loudness === null ? [] : [sample.loudness],
  );
  const reading: Reading = {
    shake: mean(window.inside.map((sample) => sample.motion)) / SHAKY,
    light: mostCommon(window.inside.map((sample) => sample.light)),
    quiet: loud.length > 0 && mean(loud) < QUIET,
    short: setup.kind === "video" && window.duration < setup.length * SHORT_SHARE,
  };
  return {
    startSeconds: window.start,
    endSeconds: window.end,
    score: scoreOf(reading, setup),
    praise: praiseOf(reading, setup),
    tip: tipOf(reading, setup),
    lateStart: setup.kind === "video" && window.start > LATE_START_SECONDS,
  };
}
