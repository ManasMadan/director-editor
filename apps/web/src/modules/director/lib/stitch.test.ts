import { describe, expect, it } from "vitest";
import { coverRect, OUTPUT_HEIGHT, OUTPUT_WIDTH, totalSeconds } from "./stitch";

describe("the stitcher's arithmetic", () => {
  it("covers the 9:16 frame with a picture of any shape, cropping its middle", () => {
    expect(coverRect(1280, 720)).toEqual({
      x: (OUTPUT_WIDTH - 1280 * (OUTPUT_HEIGHT / 720)) / 2,
      y: 0,
      w: 1280 * (OUTPUT_HEIGHT / 720),
      h: OUTPUT_HEIGHT,
    });
    expect(coverRect(720, 1280)).toEqual({ x: 0, y: 0, w: OUTPUT_WIDTH, h: OUTPUT_HEIGHT });
    const zoomed = coverRect(720, 1280, 1.1);
    expect(zoomed.w).toBeCloseTo(OUTPUT_WIDTH * 1.1);
    expect(zoomed.x).toBeCloseTo(-OUTPUT_WIDTH * 0.05);
  });

  it("adds up each cut's time in the edit", () => {
    const blob = new Blob([]);
    expect(
      totalSeconds([
        { kind: "video", source: blob, startSeconds: 0.5, endSeconds: 3 },
        { kind: "photo", source: blob, seconds: 2 },
      ]),
    ).toBe(4.5);
  });
});
