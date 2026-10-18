import { describe, expect, it } from "vitest";
import { viewCrop } from "./view";

describe("the viewfinder", () => {
  it("crops a wide camera frame to its middle 9:16", () => {
    expect(viewCrop(1280, 720)).toEqual({ x: 437.5, y: 0, width: 405, height: 720 });
    expect(viewCrop(720, 1280)).toEqual({ x: 0, y: 0, width: 720, height: 1280 });
  });

  it("crops a tall camera frame to its middle 9:16", () => {
    expect(viewCrop(900, 2000)).toEqual({ x: 0, y: 200, width: 900, height: 1600 });
  });
});
