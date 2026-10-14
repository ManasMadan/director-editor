import { describe, expect, it } from "vitest";
import { tiltFromOrientation, tiltHint, tiltInRange, tiltOffset } from "./tilt";

const target = { pitch: -60, roll: 0, tolerance: 10, height: "shoulder" } as const;

describe("the phone's tilt", () => {
  it("reads the back camera's pitch from how far the phone stands up", () => {
    expect(tiltFromOrientation(90, 0, "back")).toEqual({ pitch: 0, roll: 0 });
    expect(tiltFromOrientation(0, 0, "back")).toEqual({ pitch: -90, roll: 0 });
    expect(tiltFromOrientation(120, 5, "back")).toEqual({ pitch: 30, roll: 5 });
  });

  it("points the front camera the other way", () => {
    expect(tiltFromOrientation(0, 0, "front").pitch).toBe(90);
    expect(tiltFromOrientation(100, -8, "front")).toEqual({ pitch: -10, roll: -8 });
  });

  it("keeps readings inside the plan's range", () => {
    expect(tiltFromOrientation(-180, 120, "back")).toEqual({ pitch: -90, roll: 90 });
  });

  it("says how far off the target it is, and when it's close enough", () => {
    const tilt = tiltFromOrientation(25, 4, "back");
    expect(tiltOffset(tilt, target)).toEqual({ pitch: 5, roll: -4 });
    expect(tiltInRange(tilt, target)).toBe(true);
    expect(tiltInRange(tiltFromOrientation(60, 0, "back"), target)).toBe(false);
    expect(tiltInRange(tiltFromOrientation(30, 20, "back"), target)).toBe(false);
  });

  it("says which way to fix the axis that's furthest off", () => {
    expect(tiltHint({ pitch: 12, roll: 3 })).toBe("tipUp");
    expect(tiltHint({ pitch: -12, roll: 3 })).toBe("tipDown");
    expect(tiltHint({ pitch: 2, roll: 9 })).toBe("leanRight");
    expect(tiltHint({ pitch: 2, roll: -9 })).toBe("leanLeft");
  });
});
