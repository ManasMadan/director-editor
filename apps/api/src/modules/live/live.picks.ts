/**
 * Picks during the shoot: Director's `rate` tool. After each attempt Director rates it
 * (a score and a one-line reason), and the relay answers whether that makes it the new
 * best of its shot, so Director can say so out loud; when the member says "use that
 * one" or "use the second one", the same tool makes that take their choice for the shot,
 * which the editor then shows first (`LivePicks`, the API's side of it).
 *
 * The relay handles `rate` itself rather than handing it to the browser: nothing on
 * screen has to act first, and the member's choice is stored by the API. The browser's
 * shot list follows it through the `director.changed` nudge every choice sends.
 *
 * Attempts are numbered per shot, from 1, in the order filmed in this shoot: a take
 * recorded and then thrown away to go again isn't one (the per-take shutter), so it gives
 * its number back.
 */
import type { LiveTakeState } from "@repo/contracts/live";
import { required } from "@repo/contracts/objects";
import * as z from "zod";

export const RATE_TOOL = "rate";
/** A reason is one line under a tile in the editor. */
const REASON_MAX_LENGTH = 160;

/** The API's side: makes one of this shoot's takes of a shot the member's choice. */
export interface LivePicks {
  /**
   * `take` is the attempt's number in the shot, from 1, among this shoot's takes;
   * `not_found` while there's no such take yet (it may still be on its way up).
   */
  choose(shot: number, take: number): Promise<"done" | "not_found">;
}

/** What Gemini declares for `rate` (the Live API's function declaration). */
export const RATE_DECLARATION = {
  name: RATE_TOOL,
  description:
    'Rate an attempt at a shot right after it ends: your score and a short, specific reason. Also when they say which take to use ("use that one", "use the second one"): set use to true. The answer says whether it\'s the new best one.',
  parameters: {
    type: "OBJECT",
    properties: {
      shot: { type: "INTEGER", description: "The shot's number, from 1. Leave out for this shot." },
      take: {
        type: "INTEGER",
        description:
          "The attempt's number in the shot, from 1, in the order filmed. Leave out for the last one.",
      },
      score: { type: "INTEGER", description: "0 to 100: how good it is." },
      reason: {
        type: "STRING",
        description: 'One short line on what made it work or not: "the cleanest delivery".',
      },
      use: { type: "BOOLEAN", description: "They said to use this one." },
    },
  },
};

/** What the persona adds for picking, kept beside the tool it describes. */
export const PICKS_PERSONA = `Picking the best take:
- After each attempt ends, call rate with your score and a short reason about something specific you saw or heard. If the answer says it's the new best, tell them in a few words ("that's the new best one"). Don't say the score unless they ask.
- When they say which one to use ("that one was good, use it", "use the second one"), call rate with use set to true and that attempt's number, then confirm in a few words. Their choice always wins.
- If they want to redo only the last line, tell them to say just that line again; it counts as another attempt at the shot.`;

const rateArgs = z.object({
  shot: z.number().int().optional(),
  take: z.number().int().optional(),
  score: z.number().int().min(0).max(100).optional(),
  reason: z.string().trim().min(1).max(REASON_MAX_LENGTH).optional(),
  use: z.boolean().optional(),
});

interface Best {
  take: number;
  score: number;
}

/** The shoot's attempts and Director's live ratings, shot by shot. */
export class ShotTally {
  private readonly attempts = new Map<number, number>();
  private readonly scores = new Map<number, Map<number, number>>();

  /** A take ended (one more attempt) or was thrown away (its number given back). */
  onTake(state: LiveTakeState, shot: number) {
    const count = this.attempts.get(shot) ?? 0;
    if (state === "recorded") {
      this.attempts.set(shot, count + 1);
    } else if (state === "discarded" && count > 0) {
      this.scores.get(shot)?.delete(count);
      this.attempts.set(shot, count - 1);
    }
  }

  count(shot: number) {
    return this.attempts.get(shot) ?? 0;
  }

  private best(shot: number): Best | null {
    let best: Best | null = null;
    for (const [take, score] of this.scores.get(shot) ?? []) {
      // A later take only takes over by beating it: "the new best" means better.
      if (best === null || score > best.score) {
        best = { take, score };
      }
    }
    return best;
  }

  /** Records Director's score for an attempt; whether that made it the shot's best. */
  rate(shot: number, take: number, score: number) {
    const before = this.best(shot)?.take;
    const scores = this.scores.get(shot) ?? new Map<number, number>();
    scores.set(take, score);
    this.scores.set(shot, scores);
    const after = required(this.best(shot), "the shot's best, just rated").take;
    return { newBest: after === take && before !== take, bestTake: after };
  }
}

/**
 * Carries out a `rate` call for the member on shot `current` (0-based) of a plan of
 * `shotCount` shots: checks the arguments, records the score, and makes the take the
 * member's choice when they said to use it. Answers what Gemini hears back.
 */
export async function rate(
  raw: unknown,
  current: number,
  shotCount: number,
  tally: ShotTally,
  picks: LivePicks,
): Promise<object> {
  const args = rateArgs.safeParse(raw ?? {});
  if (!args.success) {
    return { error: "shot and take are whole numbers, score 0 to 100, reason one short line" };
  }
  const shotNumber = args.data.shot ?? current + 1;
  if (shotNumber < 1 || shotNumber > shotCount) {
    return {
      result: "not_found",
      why: `There's no shot ${shotNumber}: they go from 1 to ${shotCount}.`,
    };
  }
  const shot = shotNumber - 1;
  const take = args.data.take ?? tally.count(shot);
  if (take < 1) {
    return { result: "not_found", why: "There's no attempt at that shot yet." };
  }
  const rated = args.data.score === undefined ? null : tally.rate(shot, take, args.data.score);
  if (args.data.use) {
    const chosen = await picks.choose(shot, take);
    if (chosen === "not_found") {
      return {
        result: "not_found",
        why: `Attempt ${take} of shot ${shotNumber} isn't saved yet, or there isn't one: ask again in a moment, or check the number.`,
      };
    }
    return { result: "done", chosen: true, take };
  }
  if (rated === null) {
    return { result: "done" };
  }
  return { result: "done", new_best: rated.newBest, best_take: rated.bestTake };
}
