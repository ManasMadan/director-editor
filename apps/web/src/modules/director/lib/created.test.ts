import { describe, expect, it } from "vitest";
import { moved, newShot, type ShotDraft, shotsValid } from "./created";

const shot = (title: string, scene = "By the window"): ShotDraft => ({
  kind: "video",
  mode: "on-camera",
  title,
  purpose: "hook",
  sourceStartSeconds: 0,
  sourceEndSeconds: 4,
  durationSeconds: 4,
  camera: "back",
  scene,
  sceneLandmark: "window",
  framing: { shotSize: "close-up", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "chest" },
  pose: { description: "Hands", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Pour.", cameraMove: "static" }],
  script: [{ startSeconds: 0, endSeconds: 1, text: "Hi" }],
  storyboardUrl: "https://storage.test/card.png",
});

describe("moving a shot", () => {
  const shots = ["a", "b", "c"];
  it("moves it up or down a place", () => {
    expect(moved(shots, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(shots, 1, 1)).toEqual(["a", "c", "b"]);
  });
  it("keeps it inside the list", () => {
    expect(moved(shots, 0, -1)).toEqual(shots);
    expect(moved(shots, 2, 1)).toEqual(shots);
    expect(moved(shots, 5, 1)).toEqual(shots);
  });
});

describe("a new shot", () => {
  it("is set up like the last one, in the member's words, with nothing said and no card", () => {
    const added = newShot([shot("First"), shot("Last")], { title: "New", scene: "Anywhere" });
    expect(added).toMatchObject({
      title: "New",
      scene: "Anywhere",
      sceneLandmark: null,
      script: [],
      camera: "back",
      steps: [{ atSeconds: 0, instruction: "Anywhere", cameraMove: "static" }],
    });
    expect(added).not.toHaveProperty("storyboardUrl");
  });
  it("needs a shot to copy", () => {
    expect(() => newShot([], { title: "New", scene: "Anywhere" })).toThrow();
  });
});

it("needs every shot to say what happens and where", () => {
  expect(shotsValid([shot("A")])).toBe(true);
  expect(shotsValid([shot(" ")])).toBe(false);
  expect(shotsValid([shot("A", "")])).toBe(false);
  expect(shotsValid([])).toBe(false);
});
