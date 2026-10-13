import { describe, expect, it } from "vitest";
import {
  difference,
  lightOf,
  lumaOf,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  steadyReading,
} from "./frame-stats";

const size = SAMPLE_WIDTH * SAMPLE_HEIGHT;

/** A sample whose middle and edges have the given brightness. */
function sample(centre: number, edges = centre) {
  const luma = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const x = index % SAMPLE_WIDTH;
    const y = Math.floor(index / SAMPLE_WIDTH);
    const middle =
      x >= SAMPLE_WIDTH * 0.3 &&
      x < SAMPLE_WIDTH * 0.7 &&
      y >= SAMPLE_HEIGHT * 0.25 &&
      y < SAMPLE_HEIGHT * 0.75;
    luma[index] = middle ? centre : edges;
  }
  return luma;
}

describe("frame stats", () => {
  it("weighs green most, as the eye does", () => {
    const [red, green, blue] = lumaOf([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9]);
    expect(green).toBeGreaterThan(red ?? 0);
    expect(red).toBeGreaterThan(blue ?? 0);
    expect(lumaOf([255, 255, 255, 255])[0]).toBeCloseTo(1);
  });

  it("tells good light from too dark, too bright and a light behind the subject", () => {
    expect(lightOf(sample(0.5))).toBe("good");
    expect(lightOf(sample(0.08))).toBe("too-dark");
    expect(lightOf(sample(0.95))).toBe("too-bright");
    expect(lightOf(sample(0.2, 0.75))).toBe("backlit");
    expect(lightOf(new Float32Array(0))).toBe("too-dark");
  });

  it("measures how much the picture changed", () => {
    expect(difference(sample(0.4), sample(0.4))).toBe(0);
    expect(difference(sample(0.2), sample(0.6))).toBeCloseTo(0.4);
    expect(difference(sample(0.2), new Float32Array(3))).toBe(1);
  });

  it("only settles on a reading that holds", () => {
    const read = steadyReading<string>(3);
    expect(read("dark")).toBeNull();
    expect(read("dark")).toBeNull();
    expect(read("dark")).toBe("dark");
    expect(read("good")).toBe("dark");
    expect(read("good")).toBe("dark");
    expect(read("good")).toBe("good");
  });
});
