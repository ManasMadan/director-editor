import { describe, expect, it } from "vitest";
import { bodyInView, toView, viewCrop } from "./view";

describe("the viewfinder", () => {
  it("crops a wide camera frame to its middle 9:16", () => {
    expect(viewCrop(1280, 720)).toEqual({ x: 437.5, y: 0, width: 405, height: 720 });
    expect(viewCrop(720, 1280)).toEqual({ x: 0, y: 0, width: 720, height: 1280 });
  });

  it("crops a tall camera frame to its middle 9:16", () => {
    expect(viewCrop(900, 2000)).toEqual({ x: 0, y: 200, width: 900, height: 1600 });
  });

  it("maps camera-frame fractions into the viewfinder's", () => {
    expect(toView({ x: 0.5, y: 0.5 }, 1280, 720)).toEqual({ x: 0.5, y: 0.5 });
    expect(toView({ x: 437.5 / 1280, y: 0 }, 1280, 720)).toEqual({ x: 0, y: 0 });
    expect(bodyInView({ nose: { x: 0.5, y: 0.1 } }, 900, 2000)).toEqual({
      nose: { x: 0.5, y: expect.closeTo(0, 5) },
    });
  });
});
