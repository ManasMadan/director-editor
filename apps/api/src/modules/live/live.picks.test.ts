import { describe, expect, it, vi } from "vitest";
import { type LivePicks, rate, ShotTally } from "./live.picks";

const SHOTS = 3;

function picks(answer: "done" | "not_found" = "done") {
  return { choose: vi.fn<LivePicks["choose"]>(() => Promise.resolve(answer)) };
}

/** A tally with `count` attempts at shot `shot`. */
function attempts(count: number, shot = 0) {
  const tally = new ShotTally();
  for (let i = 0; i < count; i += 1) {
    tally.onTake("recorded", shot);
  }
  return tally;
}

describe("Director rating attempts", () => {
  it("says when an attempt is the new best, and only when it beats the best so far", async () => {
    const tally = attempts(4);
    const at = (take: number, score: number) =>
      rate({ take, score, reason: "Nice." }, 0, SHOTS, tally, picks());
    expect(await at(1, 70)).toEqual({ result: "done", new_best: true, best_take: 1 });
    expect(await at(2, 60)).toEqual({ result: "done", new_best: false, best_take: 1 });
    // A tie isn't a new best.
    expect(await at(3, 70)).toEqual({ result: "done", new_best: false, best_take: 1 });
    expect(await at(4, 90)).toEqual({ result: "done", new_best: true, best_take: 4 });
  });

  it("rates the last attempt of this shot unless told which", async () => {
    const tally = attempts(2);
    expect(await rate({ score: 80 }, 0, SHOTS, tally, picks())).toEqual({
      result: "done",
      new_best: true,
      best_take: 2,
    });
    // Nothing to rate is still an answer.
    expect(await rate({}, 0, SHOTS, tally, picks())).toEqual({ result: "done" });
  });

  it("gives a thrown-away take's number back, with its score", async () => {
    const tally = attempts(2);
    await rate({ score: 95 }, 0, SHOTS, tally, picks());
    tally.onTake("discarded", 0);
    expect(tally.count(0)).toBe(1);
    // Take 2 again: its old score is gone, so 50 is the best.
    tally.onTake("recorded", 0);
    expect(await rate({ score: 50 }, 0, SHOTS, tally, picks())).toEqual({
      result: "done",
      new_best: true,
      best_take: 2,
    });
    // Other states, and a discard with nothing recorded, change nothing.
    const empty = new ShotTally();
    empty.onTake("countdown", 1);
    empty.onTake("discarded", 1);
    expect(empty.count(1)).toBe(0);
  });

  it("makes the take the member named their choice, on the shot they named", async () => {
    const tally = attempts(4, 1);
    const api = picks();
    expect(await rate({ shot: 2, take: 2, use: true }, 0, SHOTS, tally, api)).toEqual({
      result: "done",
      chosen: true,
      take: 2,
    });
    expect(api.choose).toHaveBeenCalledWith(1, 2);
  });

  it("says when the take isn't saved yet, there's no attempt, or no such shot", async () => {
    const tally = attempts(1);
    expect(await rate({ take: 3, use: true }, 0, SHOTS, tally, picks("not_found"))).toEqual({
      result: "not_found",
      why: expect.stringContaining("Attempt 3 of shot 1 isn't saved yet"),
    });
    expect(await rate({ use: true }, 1, SHOTS, tally, picks())).toEqual({
      result: "not_found",
      why: "There's no attempt at that shot yet.",
    });
    expect(await rate({ shot: 4 }, 0, SHOTS, tally, picks())).toEqual({
      result: "not_found",
      why: "There's no shot 4: they go from 1 to 3.",
    });
    expect(await rate({ shot: 0 }, 0, SHOTS, tally, picks())).toMatchObject({
      result: "not_found",
    });
  });

  it("refuses arguments it can't read", async () => {
    for (const bad of [{ take: 1.5 }, { score: 101 }, { reason: "" }, "nonsense"]) {
      expect(await rate(bad, 0, SHOTS, attempts(1), picks())).toEqual({
        error: expect.stringContaining("whole numbers"),
      });
    }
    // No arguments at all is a rating of nothing yet.
    expect(await rate(undefined, 0, SHOTS, attempts(0), picks())).toEqual({
      result: "not_found",
      why: "There's no attempt at that shot yet.",
    });
  });
});
