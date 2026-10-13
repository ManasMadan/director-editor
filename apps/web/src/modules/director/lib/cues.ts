/**
 * Director's one voice. Everything that could say something (the scene check, the light,
 * the framing, the angle, the pose, what's in the frame, the steps) offers a cue; this
 * picks the one that matters most and decides when it may be said, so Director never
 * talks over itself, never nags with the same line, and lets the member finish speaking.
 *
 * - One line at a time: after a cue, others wait a breath (`GAP_SECONDS`) unless they
 *   matter more, which is how "Great spot!" can cut off a direction that's now stale.
 * - No nagging: each cue has a cooldown before it may be said again.
 * - Turn-taking: when the member speaks, Director holds its next line for the same breath.
 *
 * The words come in already translated (`Words`), so this stays free of the UI.
 */
import type { SceneCheck } from "@repo/contracts/api";
import type { Light } from "./frame-stats";
import type { FramingHint } from "./framing";
import type { Seen } from "./things";
import type { TiltHint } from "./tilt";

/** A breath between lines, in seconds. */
export const GAP_SECONDS = 3.5;
const DEFAULT_COOLDOWN = 15;
/** Said once a session. */
const ONCE = Number.POSITIVE_INFINITY;

export type Mood = "guide" | "cheer" | "warn";

export interface Cue {
  /** What it's about: the same id isn't said again within its cooldown. */
  id: string;
  text: string;
  priority: number;
  mood: Mood;
  cooldown: number;
}

type LightProblem = Exclude<Light, "good">;

export interface Words {
  greeting: string;
  offline: string;
  ready: string;
  inPlace: string;
  matched: string;
  match: string;
  action: string;
  count: (seconds: number) => string;
  /** The countdown's first number, said the way a set calls it: "Quiet on set. Rolling in 3". */
  rolling: (seconds: number) => string;
  light: Record<LightProblem, string>;
  framing: Record<Exclude<FramingHint, "in-frame">, string>;
  angle: Record<TiltHint, string>;
  thing: (seen: Seen) => string;
}

export interface Perception {
  phase: "setup" | "countdown" | "recording" | "preview" | "sending";
  /** The member paused Director. */
  paused: boolean;
  /** Showing Director a screen instead of the camera: it brainstorms. */
  sharing: boolean;
  /** A take is recording the member's voice: Director stays silent. */
  micRecording: boolean;
  countdown: number | null;
  countdownFrom: number;
  /** Gemini's latest look at the scene, and whether Gemini is out of reach. */
  scene: SceneCheck | null;
  offline: boolean;
  /** The light as the phone measures it, before Gemini says. */
  light: Light | null;
  framing: FramingHint | null;
  angle: TiltHint | null;
  /** Null when the shot has no pose to match. */
  posed: boolean | null;
  ready: boolean;
  /** The things worth pointing out in the frame now. */
  things: readonly Seen[];
  /** The step coming up while recording. */
  step: { index: number; instruction: string } | null;
  /** The shot's ideas from the plan (its purpose, framing note, pose): for brainstorming. */
  ideas: readonly string[];
}

const cue = (
  id: string,
  text: string,
  priority: number,
  mood: Mood = "guide",
  cooldown = DEFAULT_COOLDOWN,
): Cue => ({ id, text, priority, mood, cooldown });

/** Getting the shot set up: where to be, the light, the frame, the angle, the pose. */
function setupCues(p: Perception, words: Words): Cue[] {
  if (p.ready) {
    return [cue("ready", words.ready, 9, "cheer", 30)];
  }
  const cues: Cue[] = [];
  const light = p.light && p.light !== "good" ? p.light : p.scene?.lighting;
  if (light && light !== "good") {
    cues.push(cue(`light:${light}`, words.light[light], 7, "warn", 20));
  }
  if (p.scene?.inPlace) {
    cues.push(cue("scene:in-place", words.inPlace, 8, "cheer", ONCE));
  } else if (p.scene) {
    cues.push(cue(`scene:${p.scene.instruction}`, p.scene.instruction, 6));
  }
  if (p.framing && p.framing !== "in-frame") {
    cues.push(cue(`framing:${p.framing}`, words.framing[p.framing], 5));
  }
  if (p.angle) {
    cues.push(cue(`angle:${p.angle}`, words.angle[p.angle], 4));
  }
  if (p.posed === true) {
    cues.push(cue("pose:matched", words.matched, 7, "cheer", 30));
  } else if (p.posed === false && p.framing === "in-frame") {
    cues.push(cue("pose:match", words.match, 3));
  }
  return cues;
}

/** What Director notices around the member, and its ideas while it looks at a screen. */
function noticeCues(p: Perception, words: Words): Cue[] {
  const cues = p.things.map((seen) =>
    cue(`thing:${seen.thing}`, words.thing(seen), 2, "guide", ONCE),
  );
  if (p.sharing) {
    cues.push(...p.ideas.map((idea, index) => cue(`idea:${index}`, idea, 3, "guide", ONCE)));
  }
  if (p.offline) {
    cues.push(cue("offline", words.offline, 1, "guide", ONCE));
  }
  return cues;
}

function countCue(left: number, from: number, words: Words): Cue {
  const text = left === from ? words.rolling(left) : words.count(left);
  return cue(`count:${left}`, text, 20 - left, "guide", ONCE);
}

/** A step as recording reaches it; the first opens with "Action!", two sentences said as one. */
function stepCue(step: NonNullable<Perception["step"]>, words: Words): Cue {
  const text = step.index === 0 ? `${words.action} ${step.instruction}` : step.instruction;
  return cue(
    `step:${step.index}`,
    text,
    20 + step.index,
    step.index === 0 ? "cheer" : "guide",
    ONCE,
  );
}

/** Every cue that could be said now, with the greeting that opens the session. */
export function cuesFor(p: Perception, words: Words): Cue[] {
  if (p.paused) {
    return [];
  }
  const greeting = cue("greeting", words.greeting, 10, "cheer", ONCE);
  switch (p.phase) {
    case "setup":
      return [greeting, ...(p.sharing ? [] : setupCues(p, words)), ...noticeCues(p, words)];
    // Time-critical lines outrank everything before them, each the one after it.
    case "countdown":
      return p.countdown === null ? [] : [countCue(p.countdown, p.countdownFrom, words)];
    case "recording":
      return p.micRecording || !p.step ? [] : [stepCue(p.step, words)];
    default:
      return [];
  }
}

export interface Log {
  /** When the last line began, and how much it mattered. */
  at: number;
  priority: number;
  said: ReadonlyMap<string, number>;
}

export const QUIET_LOG: Log = { at: Number.NEGATIVE_INFINITY, priority: 0, said: new Map() };

/** The cue to say at `now` (seconds), or null to stay quiet for now. */
export function pick(cues: readonly Cue[], log: Log, now: number): Cue | null {
  let best: Cue | null = null;
  for (const each of cues) {
    const last = log.said.get(each.id) ?? Number.NEGATIVE_INFINITY;
    if (now - last >= each.cooldown && (!best || each.priority > best.priority)) {
      best = each;
    }
  }
  if (!best) {
    return null;
  }
  const breathing = now - log.at < GAP_SECONDS;
  return breathing && best.priority <= log.priority ? null : best;
}

/** The log once `said` has been said at `now`. */
export function logged(log: Log, said: Cue, now: number): Log {
  return { at: now, priority: said.priority, said: new Map(log.said).set(said.id, now) };
}

/** The log once the member has spoken at `now`: Director waits its turn. */
export function heard(log: Log, now: number): Log {
  return { ...log, at: now, priority: Math.max(log.priority, 8) };
}
