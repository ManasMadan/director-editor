/**
 * What the relay refuses of Director's tool calls before the browser sees them, and why
 * (Gemini hears the reason at once, in words it acts on):
 *
 * - the same tool over and over: in UAT, Director called `mark end` some sixty times in
 *   ninety seconds, each answered "done", and said nothing to the member meanwhile. More
 *   than TOOL_REPEATS calls of one tool in TOOL_WINDOW_MS are refused and logged;
 * - marks that can't be right: an end with no attempt open (that loop again), a start
 *   while one is open, and a start in a turn where Director itself is talking: an
 *   attempt is the member's go at the shot, never Director reading the line out.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { SlidingBudget } from "./live.budget";

/** One tool's calls in a window: a burst of real use fits, a loop doesn't. */
const TOOL_REPEATS = 5;
const TOOL_WINDOW_MS = 10 * SECOND_MS;

export const REFUSALS = {
  repeated: {
    result: "refused",
    why: "You've called this over and over. Stop calling it and talk to them: answer what they last said.",
  },
  noneOpen: {
    result: "refused",
    why: "No attempt is open: it's already marked as ended. Don't mark it again. Give your note now, or wait for their next attempt.",
  },
  alreadyOpen: {
    result: "refused",
    why: "An attempt is already open. Mark its end when they finish; don't start another.",
  },
  ownVoice: {
    result: "refused",
    why: "You were talking: an attempt is theirs, never your own words. Mark start only when they begin the shot's action or line, without speaking yourself.",
  },
} as const;

/** Counts each tool's calls, so a tool called in a loop is caught. */
export class ToolRepeats {
  private readonly budgets = new Map<string, SlidingBudget>();

  constructor(private readonly now: () => number) {}

  /** Whether one more call of `tool` fits its window. */
  allows(tool: string): boolean {
    let budget = this.budgets.get(tool);
    if (!budget) {
      budget = new SlidingBudget(TOOL_REPEATS, TOOL_WINDOW_MS, this.now);
      this.budgets.set(tool, budget);
    }
    return budget.spend(1);
  }
}

/**
 * Whether 100 ms of the member's microphone (16-bit PCM, base64) has someone talking in
 * it, not just a quiet room: its level is past about -30 dBFS. The relay counts that as
 * heard, so a quiet nudge never lands on the member speaking before Gemini's transcript
 * of it arrives.
 */
const VOICE_LEVEL = 0.03;

export function hasVoice(pcm16: string): boolean {
  const bytes = Buffer.from(pcm16, "base64");
  const samples = Math.floor(bytes.length / 2);
  if (samples === 0) {
    return false;
  }
  let sum = 0;
  for (let at = 0; at < samples; at += 1) {
    const sample = bytes.readInt16LE(at * 2) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples) > VOICE_LEVEL;
}
