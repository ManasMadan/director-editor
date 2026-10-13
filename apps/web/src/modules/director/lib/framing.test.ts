import { describe, expect, it } from "vitest";
import { bodyBox, framingHint } from "./framing";

const target = { x: 0.3, y: 0.1, width: 0.4, height: 0.8 };
const box = (x: number, height: number) => ({ x, y: 0.1, width: 0.4, height });

describe("framing", () => {
  it("boxes the joints it can see, inside the frame", () => {
    expect(bodyBox({ nose: { x: 0.5, y: 0.1 } })).toBeNull();
    expect(
      bodyBox({
        nose: { x: 0.5, y: -0.1 },
        left_hip: { x: 0.6, y: 0.5 },
        right_ankle: { x: 0.4, y: 1.2 },
      }),
    ).toEqual({ x: 0.4, y: 0, width: expect.closeTo(0.2), height: 1 });
    const dot = { x: 0.5, y: 0.5 };
    expect(bodyBox({ nose: dot, left_hip: dot, right_hip: dot })).toMatchObject({
      width: 0.01,
      height: 0.01,
    });
  });

  it("says to come into frame, closer or back first", () => {
    expect(framingHint(target, null, "front")).toBe("not-seen");
    expect(framingHint(target, box(0.3, 0.4), "front")).toBe("come-closer");
    expect(framingHint(target, box(0.3, 1.2), "back")).toBe("step-back");
    expect(framingHint(target, box(0.32, 0.8), "back")).toBe("in-frame");
  });

  it("moves the person for the selfie camera and the phone for the back one", () => {
    expect(framingHint(target, box(0.05, 0.8), "front")).toBe("step-left");
    expect(framingHint(target, box(0.55, 0.8), "front")).toBe("step-right");
    expect(framingHint(target, box(0.05, 0.8), "back")).toBe("aim-left");
    expect(framingHint(target, box(0.55, 0.8), "back")).toBe("aim-right");
  });
});
