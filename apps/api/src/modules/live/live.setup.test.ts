/** How Director is briefed on the member's version of a shot, and where they are in it. */
import { EMPTY_VERSION, type ShotPlan, shotPlanSchema } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { systemInstruction, versionMessage, whereTheyAre } from "./live.setup";

const shot = {
  kind: "video",
  title: "The pour",
  purpose: "Open on the coffee.",
  sourceStartSeconds: 0,
  sourceEndSeconds: 3,
  durationSeconds: 3,
  camera: "back",
  scene: "At a kitchen counter",
  sceneLandmark: "mug",
  framing: {
    shotSize: "close-up",
    subject: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    note: "The mug in the middle.",
  },
  phoneAngle: { pitch: -20, roll: 0, tolerance: 10, height: "chest" },
  pose: { description: "One hand pouring", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Pour slowly", cameraMove: "static" }],
  script: [],
};

const plan: ShotPlan = shotPlanSchema.parse({
  title: "Morning coffee",
  format: "GRWM",
  summary: "Making coffee before work.",
  audio: "speech",
  durationSeconds: 9,
  shots: [shot, { ...shot, title: "The sip", steps: [] }, { ...shot, title: "The cup" }],
});

describe("the member's version in Director's brief", () => {
  it("names the camera they film a shot on", () => {
    const version = { ...EMPTY_VERSION, shots: [{ shot: 0, camera: "front" as const }] };
    const text = systemInstruction(plan, 0, version);
    expect(text).toContain("- Camera: the front camera");
    expect(text).toContain("on the front camera.");
  });

  it("puts what they do in the first step of a shot that has steps", () => {
    const version = { ...EMPTY_VERSION, shots: [{ shot: 0, action: "Pour it fast" }] };
    const text = systemInstruction(plan, 0, version);
    expect(text).toContain("- at 0s: Pour it fast (camera: static)");
    expect(text).not.toContain("Pour slowly");
  });

  it("puts what they do in the pose of a shot with no steps", () => {
    const version = { ...EMPTY_VERSION, shots: [{ shot: 1, action: "Sip, then smile" }] };
    expect(systemInstruction(plan, 1, version)).toContain("Pose: Sip, then smile");
  });

  it("says nothing of a version that changes nothing in the shot", () => {
    const version = { ...EMPTY_VERSION, shots: [{ shot: 0 }] };
    expect(systemInstruction(plan, 0, version)).not.toContain("Their version of this shot");
    expect(JSON.stringify(versionMessage(version, 0))).not.toContain("Their version");
  });
});

describe("where the member is", () => {
  it("is on a skipped shot, with the next one they film to go to", () => {
    const version = { ...EMPTY_VERSION, skipped: [1] };
    expect(whereTheyAre(version, 1, 3)).toEqual({
      shot: 2,
      status: "skipped",
      say: "Shot 2, the one on their screen, is now skipped: tell them, and ask whether to go to shot 3. Move only once they say yes.",
    });
  });
});
