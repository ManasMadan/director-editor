import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import {
  awayFromDirectorsPicks,
  cutPicks,
  directorsPicks,
  pickedTakes,
  picksFirst,
  stepPick,
  takeNumber,
  takesInOrder,
} from "./picks";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Take `n` of shot `shotIndex`, filmed `n` seconds in. */
function take(n: number, shotIndex = 0, score: number | null = null): DirectorTake {
  return {
    id: directorTakeIdSchema.parse(id(n)),
    shotIndex,
    fileId: fileIdSchema.parse(id(100 + n)),
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score,
    feedback: null,
    reason: null,
    chosen: false,
    origin: "shoot",
    createdAt: new Date(n * 1000),
  };
}

/** A shot as the API lists it: takes newest first. */
function shot(
  index: number,
  takes: DirectorTake[],
  picked: DirectorTake | null = null,
  chosen: DirectorTake | null = null,
) {
  return {
    index,
    takes: [...takes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    pickedTakeId: picked?.id ?? null,
    chosenTakeId: chosen?.id ?? null,
    needsRetake: false,
  } satisfies DirectorShot;
}

describe("a shot's takes", () => {
  it("are numbered in the order they were filmed", () => {
    const [first, second, third] = [take(1), take(2), take(3)];
    const listed = shot(0, [first, second, third]);
    expect(takesInOrder(listed)).toEqual([first, second, third]);
    expect(takeNumber(listed, third.id)).toBe(3);
    expect(takeNumber(listed, first.id)).toBe(1);
  });
});

describe("the take each shot plays", () => {
  const [a1, a2, a3] = [take(1, 0, 80), take(2, 0, 40), take(3, 0)];
  const b1 = take(4, 1);
  const shots = [shot(0, [a1, a2, a3], a1), shot(1, [b1]), shot(2, [])];

  it("is Director's pick, else the newest take, and none for a shot not filmed", () => {
    const played = pickedTakes(shots, {});
    expect(played.get(0)).toBe(a1);
    expect(played.get(1)).toBe(b1);
    expect(played.has(2)).toBe(false);
  });

  it("is never a newest take Director couldn't review while another can play", () => {
    // A take whose review failed may hold nothing to play (an empty cut), which would
    // keep the video from saving: the newest one that didn't fail plays instead.
    const failed = { ...take(6, 3), status: "failed" as const, error: "DIRECTOR_REVIEW_FAILED" };
    const waiting = take(5, 3);
    expect(pickedTakes([shot(3, [waiting, failed])], {}).get(3)).toBe(waiting);
    // Only failed takes: the newest still shows, for the member to retake.
    expect(pickedTakes([shot(3, [failed])], {}).get(3)).toBe(failed);
  });

  it("is the member's own pick over Director's, unless that take isn't the shot's", () => {
    expect(pickedTakes(shots, { 0: a2.id }).get(0)).toBe(a2);
    expect(pickedTakes(shots, { 0: b1.id }).get(0)).toBe(a1);
  });

  it("steps to the take filmed before or after, and no further than the first or last", () => {
    const first = shots[0] as DirectorShot;
    expect(stepPick(first, {}, 1)).toBe(a2.id);
    expect(stepPick(first, {}, -1)).toBeNull();
    expect(stepPick(first, { 0: a2.id }, 1)).toBe(a3.id);
    expect(stepPick(first, { 0: a3.id }, 1)).toBeNull();
    expect(stepPick(first, { 0: a3.id }, -1)).toBe(a2.id);
    expect(stepPick(shots[2] as DirectorShot, {}, 1)).toBeNull();
  });

  it("is what a saved cut records, shot by shot", () => {
    expect(cutPicks(pickedTakes(shots, { 0: a3.id }))).toEqual({ 0: a3.id, 1: b1.id });
  });
});

describe("Director's picks", () => {
  const [a1, a2, a3, a4] = [take(1, 0, 60), take(2, 0, 70), take(3, 0, 95), take(4, 0, 50)];

  it("list the member's choice first, then Director's pick, then the rest as filmed", () => {
    expect(picksFirst(shot(0, [a1, a2, a3, a4], a3, a2))).toEqual([a2, a3, a1, a4]);
    expect(picksFirst(shot(0, [a1, a2, a3, a4], a3))).toEqual([a3, a1, a2, a4]);
    expect(picksFirst(shot(0, [a1, a2]))).toEqual([a1, a2]);
  });

  it("play the member's choice from the shoot over Director's, and a tap here over both", () => {
    const shots = [shot(0, [a1, a2, a3, a4], a3, a2)];
    expect(pickedTakes(shots, {}).get(0)).toBe(a2);
    expect(pickedTakes(shots, { 0: a4.id }).get(0)).toBe(a4);
  });

  it("go back to Director's pick for every shot that has one", () => {
    const b1 = take(5, 1);
    const shots = [shot(0, [a1, a2, a3, a4], a3, a2), shot(1, [b1])];
    expect(awayFromDirectorsPicks(shots, pickedTakes(shots, {}))).toBe(true);
    const reset = directorsPicks(shots);
    expect(reset).toEqual({ 0: a3.id });
    expect(awayFromDirectorsPicks(shots, pickedTakes(shots, reset))).toBe(false);
  });
});
