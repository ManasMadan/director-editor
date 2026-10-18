import { EMPTY_VERSION, type Shot } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import {
  adapted,
  films,
  forgotten,
  nextFilmed,
  remembered,
  restored,
  restoredRow,
  skipped,
  yourVersion,
} from "./your-version";

const original: Shot = {
  kind: "video",
  mode: "on-camera",
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
    const first = adapted(EMPTY_VERSION, { shot: 1, where: "Inside" });
    const second = adapted(first, { shot: 1, action: "Wave" });
    const third = adapted(second, { shot: 1, where: "The kitchen" });
    expect(third.shots).toEqual([{ shot: 1, where: "The kitchen", action: "Wave" }]);
    expect(adapted(third, { shot: 0, line: "Hi" }).shots).toEqual([
      { shot: 0, line: "Hi" },
      { shot: 1, where: "The kitchen", action: "Wave" },
    ]);
  });

  it("takes their framing and camera too", () => {
    const version = yourVersion(original, { shot: 0, framing: "Waist up", camera: "back" });
    expect(version.shot.framing.note).toBe("Waist up");
    expect(version.shot.camera).toBe("back");
    expect([...version.changed]).toEqual(["framing"]);
  });

  it("puts one row back, then the whole shot, and drops a shot with nothing left changed", () => {
    const changed = adapted(EMPTY_VERSION, { shot: 0, where: "Inside", line: "Hi" });
    expect(restoredRow(changed, 0, "where").shots).toEqual([{ shot: 0, line: "Hi" }]);
    expect(restoredRow(restoredRow(changed, 0, "where"), 0, "line").shots).toEqual([]);
    expect(restoredRow(changed, 3, "where")).toBe(changed);
    const away = skipped({ ...changed, gaps: [0] }, 0);
    expect(restored(away, 0)).toEqual(EMPTY_VERSION);
  });

  it("remembers a note once, forgets it whatever its case, and keeps the newest twelve", () => {
    const inside = remembered(EMPTY_VERSION, { kind: "place", note: "Inside" });
    expect(remembered(inside, { kind: "place", note: "inside" }).notes).toEqual([
      { kind: "place", note: "inside" },
    ]);
    expect(forgotten(inside, "INSIDE").notes).toEqual([]);
    let many = EMPTY_VERSION;
    for (let note = 0; note < 14; note += 1) {
      many = remembered(many, { kind: "other", note: `Note ${note}` });
    }
    expect(many.notes.map(({ note }) => note)).toEqual(
      Array.from({ length: 12 }, (_, at) => `Note ${at + 2}`),
    );
  });

  it("skips a shot once, and finds the next one they film", () => {
    const version = skipped(skipped({ ...EMPTY_VERSION, gaps: [2] }, 1), 1);
    expect(version.skipped).toEqual([1]);
    expect(films(version, 0)).toBe(true);
    expect(films(version, 2)).toBe(false);
    expect(nextFilmed(version, 0, 4)).toBe(3);
    expect(nextFilmed(version, 3, 4)).toBeNull();
  });
});
