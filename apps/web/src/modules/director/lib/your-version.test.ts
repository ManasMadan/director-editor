import type { Shot } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { adaptationList, adapted, NO_ADAPTATIONS, yourVersion } from "./your-version";

const original: Shot = {
  kind: "video",
  title: "The nod",
  purpose: "The yes",
  sourceStartSeconds: 0,
  sourceEndSeconds: 4,
  durationSeconds: 4,
  camera: "front",
  scene: "By a window",
  sceneLandmark: "window",
  framing: { shotSize: "medium", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 6, height: "eye" },
  pose: { description: "Facing the lens.", keypoints: [] },
  steps: [
    { atSeconds: 0, instruction: "Nod side to side.", cameraMove: "static" },
    { atSeconds: 2, instruction: "Smile.", cameraMove: "static" },
  ],
  script: [{ startSeconds: 1, endSeconds: 3, text: "This one's a yes." }],
};

describe("the member's version of a shot", () => {
  it("is the original until Director changes it", () => {
    const version = yourVersion(original, undefined);
    expect(version.shot).toBe(original);
    expect([...version.changed]).toEqual([]);
  });

  it("puts their place, what they do and their line in the original's place", () => {
    const version = yourVersion(original, {
      shot: 0,
      where: "On the balcony",
      action: "Grandma does the nod, you react",
      line: "Nan says yes.",
    });
    expect(version.shot.scene).toBe("On the balcony");
    expect(version.shot.steps.map((step) => step.instruction)).toEqual([
      "Grandma does the nod, you react",
      "Smile.",
    ]);
    // Their line runs across the whole shot: the original's timing was for its own words.
    expect(version.shot.script).toEqual([
      { startSeconds: 0, endSeconds: 4, text: "Nan says yes." },
    ]);
    expect(version.shot.pose).toBe(original.pose);
    expect([...version.changed]).toEqual(["where", "do", "say"]);
  });

  it("keeps the rows Director didn't change", () => {
    const version = yourVersion(original, { shot: 0, line: "Yes!" });
    expect(version.shot.scene).toBe("By a window");
    expect(version.shot.steps).toBe(original.steps);
    expect([...version.changed]).toEqual(["say"]);
  });

  it("changes the pose when the shot has no steps to change", () => {
    const still = { ...original, steps: [] };
    const version = yourVersion(still, { shot: 0, action: "Both of you wave" });
    expect(version.shot.pose.description).toBe("Both of you wave");
    expect(version.shot.steps).toEqual([]);
    expect(version.shot.script).toBe(original.script);
  });

  it("adds each change to what the shot already had", () => {
    const first = adapted(NO_ADAPTATIONS, { shot: 1, where: "Inside" });
    const second = adapted(first, { shot: 1, action: "Wave" });
    const third = adapted(second, { shot: 1, where: "The kitchen" });
    expect(third[1]).toEqual({ shot: 1, where: "The kitchen", action: "Wave" });
    expect(adaptationList(adapted(third, { shot: 0, line: "Hi" }))).toEqual([
      { shot: 0, line: "Hi" },
      { shot: 1, where: "The kitchen", action: "Wave" },
    ]);
    expect(NO_ADAPTATIONS).toEqual({});
  });
});
