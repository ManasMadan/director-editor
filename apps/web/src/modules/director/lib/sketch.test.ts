import { describe, expect, it } from "vitest";
import { boilFrame, fadeOf, lassoPoints, popScale, starPoints, wobble } from "./sketch";

describe("the hand-drawn look", () => {
  it("boils through three drawings of each line, and holds still for reduced motion", () => {
    const frames = new Set([0, 0.13, 0.26, 0.39].map((time) => boilFrame(time, false)));
    expect(frames).toEqual(new Set([0, 1, 2]));
    expect(boilFrame(0.26, true)).toBe(0);
  });

  it("wobbles the same way for the same seed", () => {
    const a = wobble(7);
    const b = wobble(7);
    expect([a(), a()]).toEqual([b(), b()]);
    expect(Math.abs(wobble(0)())).toBeLessThanOrEqual(0.5);
  });

  it("circles a box a little more than once, the end running past the start", () => {
    const box = { x: 0.2, y: 0.2, width: 0.4, height: 0.2 };
    const points = lassoPoints(box, 3, 40);
    expect(points).toHaveLength(41);
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0.05);
      expect(point.x).toBeLessThan(0.75);
    }
    const [first] = points;
    const last = points.at(-1);
    expect(
      Math.hypot((last?.x ?? 0) - (first?.x ?? 0), (last?.y ?? 0) - (first?.y ?? 0)),
    ).toBeGreaterThan(0.01);
  });

  it("pops a sticker in past full size, settles, then fades at the end of its life", () => {
    expect(popScale(0)).toBe(0);
    expect(Math.max(...[0.2, 0.25, 0.3].map(popScale))).toBeGreaterThan(1);
    expect(popScale(2)).toBeCloseTo(1);
    expect(fadeOf(0.5, 2)).toBe(1);
    expect(fadeOf(1.9, 2)).toBeCloseTo(0.1 / 0.35);
    expect(fadeOf(2, 2)).toBe(0);
  });

  it("draws a five-pointed star", () => {
    const points = starPoints({ x: 0, y: 0 }, 10, 1);
    expect(points).toHaveLength(10);
    expect(points[0]?.y).toBeLessThan(-9);
    expect(Math.hypot(points[1]?.x ?? 0, points[1]?.y ?? 0)).toBeLessThan(5);
  });
});
