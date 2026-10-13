import { describe, expect, it } from "vitest";
import { activeLine, activeStep, lineProgress } from "./timeline";

const script = [
  { startSeconds: 0, endSeconds: 2, text: "First, the top." },
  { startSeconds: 3, endSeconds: 5, text: "Then the jeans." },
];
const steps = [
  { atSeconds: 0, instruction: "Hold it up.", cameraMove: "static" as const },
  { atSeconds: 2, instruction: "Drop the pen.", cameraMove: "down" as const },
];

describe("a take's timeline", () => {
  it("lights the line being said, then the next to come, then none", () => {
    expect(activeLine(script, 1)).toBe(0);
    expect(activeLine(script, 2.5)).toBe(1);
    expect(activeLine(script, 6)).toBe(-1);
  });

  it("sweeps through the line as its time passes", () => {
    expect(lineProgress(script, 1, 2)).toBe(0);
    expect(lineProgress(script, 1, 4)).toBe(0.5);
    expect(lineProgress(script, 1, 9)).toBe(1);
    expect(lineProgress(script, 5, 1)).toBe(0);
    const instant = [{ startSeconds: 1, endSeconds: 1, text: "Hi" }];
    expect(lineProgress(instant, 0, 0)).toBe(0);
    expect(lineProgress(instant, 0, 1)).toBe(1);
  });

  it("follows the steps, starting with the first", () => {
    expect(activeStep(steps, 0)).toBe(0);
    expect(activeStep(steps, 1.9)).toBe(0);
    expect(activeStep(steps, 2)).toBe(1);
    expect(activeStep([{ atSeconds: 1, instruction: "Later.", cameraMove: "up" }], 0)).toBe(0);
  });
});
