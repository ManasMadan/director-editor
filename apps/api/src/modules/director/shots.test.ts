import { randomUUID } from "node:crypto";
import { type DirectorTake, directorTakeSchema } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { shotsOf } from "./shots";

let clock = 0;
/** A take of a shot, each one newer than the last. */
function take(shotIndex: number, score: number | null, chosen = false): DirectorTake {
  clock += 1;
  return directorTakeSchema.parse({
    id: randomUUID(),
    shotIndex,
    fileId: randomUUID(),
    kind: "video",
    status: score === null ? "pending" : "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score,
    feedback: null,
    reason: null,
    chosen,
    origin: "shoot",
    createdAt: new Date(Date.UTC(2026, 9, 18, 0, 0, clock)),
  });
}

describe("each shot's takes", () => {
  it("are grouped by shot, newest first, with the best-scored one picked", () => {
    const first = take(0, 70);
    const best = take(0, 90);
    const newer = take(0, 40);
    const shots = shotsOf(2, [first, best, newer]);
    expect(shots).toEqual([
      {
        index: 0,
        takes: [newer, best, first],
        pickedTakeId: best.id,
        chosenTakeId: null,
        needsRetake: false,
      },
      { index: 1, takes: [], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
    ]);
  });

  it("carry the member's own choice beside Director's pick", () => {
    const best = take(0, 90);
    const chosen = take(0, 50, true);
    expect(shotsOf(1, [best, chosen])[0]).toMatchObject({
      pickedTakeId: best.id,
      chosenTakeId: chosen.id,
    });
  });

  it("pick the newest of a tie", () => {
    const older = take(0, 80);
    const newer = take(0, 80);
    expect(shotsOf(1, [newer, older])[0]?.pickedTakeId).toBe(newer.id);
  });

  it("need a retake when the best scored below 60, and not at 60", () => {
    expect(shotsOf(1, [take(0, 59), take(0, 12)])[0]?.needsRetake).toBe(true);
    expect(shotsOf(1, [take(0, 60)])[0]).toMatchObject({ needsRetake: false });
  });

  it("pick nothing while no take is scored yet", () => {
    expect(shotsOf(1, [take(0, null)])[0]).toMatchObject({
      pickedTakeId: null,
      needsRetake: false,
    });
  });

  it("leave out a take of a shot the plan no longer has", () => {
    expect(shotsOf(1, [take(3, 90)])).toEqual([
      { index: 0, takes: [], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
    ]);
  });
});
