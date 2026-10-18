import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { cutPicks, pickedTakes, stepPick, takeNumber, takesInOrder } from "./picks";

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
function shot(index: number, takes: DirectorTake[], picked: DirectorTake | null = null) {
  return {
    index,
    takes: [...takes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    pickedTakeId: picked?.id ?? null,
    chosenTakeId: null,
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
