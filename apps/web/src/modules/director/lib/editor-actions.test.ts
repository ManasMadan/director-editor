import type { DirectorTake, EditorAction, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { clipsOf } from "./edit";
import {
  applyActions,
  arrange,
  type EditorChoices,
  editorState,
  fixLines,
  playOrder,
  UNARRANGED,
} from "./editor-actions";
import { gradeFilter } from "./grades";

const shot = (kind: Shot["kind"], durationSeconds: number): Shot => ({
  kind,
  mode: "on-camera",
  title: kind,
  purpose: "p",
  sourceStartSeconds: 0,
  sourceEndSeconds: durationSeconds,
  durationSeconds,
  camera: "back",
  scene: "s",
  sceneLandmark: null,
  framing: { shotSize: "medium", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "eye" },
  pose: { description: "d", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Go.", cameraMove: "static" }],
  script: [],
});

const take = (shotIndex: number, kind: DirectorTake["kind"] = "video"): DirectorTake => ({
  id: directorTakeIdSchema.parse(crypto.randomUUID()),
  shotIndex,
  fileId: fileIdSchema.parse(crypto.randomUUID()),
  kind,
  status: "ready",
  error: null,
  bestStartMs: 1000,
  bestEndMs: 4000,
  score: 80,
  feedback: null,
  reason: null,
  chosen: false,
  origin: "shoot",
  createdAt: new Date(),
});

const action = (overrides: Partial<EditorAction> & Pick<EditorAction, "op">): EditorAction => ({
  shotIndex: null,
  takeId: null,
  otherShotIndex: null,
  position: null,
  startSeconds: null,
  endSeconds: null,
  value: null,
  level: null,
  text: null,
  replacement: null,
  steps: null,
  ...overrides,
});

const shots = [shot("video", 3), shot("video", 3), shot("photo", 2)];
const takes = [take(0), take(1), take(2, "photo")];
const clips = clipsOf(shots, new Map(takes.map((one) => [one.shotIndex, one])));
const initial: EditorChoices = { style: "pop", sound: true, picks: {}, ...UNARRANGED };
const apply = (...actions: EditorAction[]) => applyActions(initial, actions, clips);

describe("Director's edits", () => {
  it("picks a take and drops the shot's old trim", () => {
    const other = directorTakeIdSchema.parse(crypto.randomUUID());
    const trimmed = { ...initial, trims: { 0: { from: 1, to: 2 } } };
    const step = applyActions(
      trimmed,
      [action({ op: "pick_take", shotIndex: 0, takeId: other })],
      clips,
    );
    expect(step.choices.picks).toEqual({ 0: other });
    expect(step.choices.trims).toEqual({});
    expect(step.shots).toEqual([0]);
  });

  it("trims a video to new points, keeping the other one, and refuses too short a clip", () => {
    const step = apply(action({ op: "trim", shotIndex: 1, endSeconds: 3.3 }));
    expect(step.choices.trims).toEqual({ 1: { from: 1, to: 3.3 } });
    expect(apply(action({ op: "trim", shotIndex: 1, startSeconds: 3.8 })).choices).toBe(initial);
    expect(apply(action({ op: "trim", shotIndex: 2, endSeconds: 1 })).choices).toBe(initial);
    expect(apply(action({ op: "trim", shotIndex: null })).choices).toBe(initial);
  });

  it("swaps, moves, drops and restores shots", () => {
    expect(
      apply(action({ op: "swap_shots", shotIndex: 0, otherShotIndex: 2 })).choices.order,
    ).toEqual([2, 1, 0]);
    expect(apply(action({ op: "move_shot", shotIndex: 2, position: 0 })).choices.order).toEqual([
      2, 0, 1,
    ]);
    const dropped = apply(action({ op: "drop_shot", shotIndex: 1 })).choices;
    expect(playOrder(dropped, [0, 1, 2])).toEqual([0, 2]);
    expect(apply(action({ op: "swap_shots", shotIndex: 0, otherShotIndex: null })).choices).toBe(
      initial,
    );
    expect(
      applyActions(dropped, [action({ op: "swap_shots", shotIndex: 1, otherShotIndex: 0 })], clips)
        .choices,
    ).toBe(dropped);
    const restored = applyActions(dropped, [action({ op: "restore_shot", shotIndex: 1 })], clips);
    expect(restored.choices.dropped).toEqual([]);
  });

  it("changes captions, fixes a word, grades shots and the voice", () => {
    const step = apply(
      action({ op: "captions", value: "off" }),
      action({ op: "captions", value: "loud" }),
      action({ op: "edit_caption", text: "cloud", replacement: "Claude" }),
      action({ op: "edit_caption", text: "Cloud", replacement: "Claude!" }),
      action({ op: "edit_caption", text: null, replacement: "x" }),
      action({ op: "set_grade", shotIndex: 0, value: "black-and-white" }),
      action({ op: "set_grade", value: "nope" }),
      action({ op: "set_volume", value: "voice", level: 0 }),
    );
    expect(step.choices.style).toBe("off");
    expect(step.choices.fixes).toEqual([{ text: "Cloud", replacement: "Claude!" }]);
    expect(step.choices.grades).toEqual({ 0: "black-and-white" });
    expect(step.choices.sound).toBe(false);
    expect(apply(action({ op: "set_grade", value: "warm" })).choices.grades).toEqual({
      0: "warm",
      1: "warm",
      2: "warm",
    });
  });

  it("hands the page what only it can do", () => {
    const step = apply(
      action({ op: "undo", steps: 2 }),
      action({ op: "redo" }),
      action({ op: "reshoot", shotIndex: 1 }),
      action({ op: "asset_request", value: "a calmer soundtrack" }),
      action({ op: "asset_request" }),
      action({ op: "set_volume", value: "music", level: 0.3 }),
      action({ op: "set_volume", value: "music" }),
    );
    expect(step.effects).toEqual([
      { kind: "undo", steps: 2 },
      { kind: "redo", steps: 1 },
      { kind: "reshoot", shotIndex: 1 },
      { kind: "asset", request: "a calmer soundtrack" },
      { kind: "music", level: 0.3 },
      { kind: "music", level: 1 },
    ]);
    expect(step.choices).toBe(initial);
  });

  it("goes back to Director's picks", () => {
    const changed = {
      ...initial,
      picks: { 0: directorTakeIdSchema.parse(crypto.randomUUID()) },
      trims: { 1: { from: 0, to: 1 } },
    };
    expect(applyActions(changed, [action({ op: "reset_to_picks" })], clips).choices).toEqual(
      initial,
    );
  });

  it("ignores shot edits without a shot", () => {
    expect(
      apply(action({ op: "pick_take", shotIndex: 0 }), action({ op: "drop_shot" })).choices,
    ).toBe(initial);
    expect(apply(action({ op: "move_shot", shotIndex: 0 })).choices).toBe(initial);
  });
});

describe("the arranged edit", () => {
  it("plays the shots in order with their trims and grades, end to end", () => {
    const choices: EditorChoices = {
      ...initial,
      order: [1, 0, 7],
      dropped: [2],
      trims: { 0: { from: 0.5, to: 1.5 } },
      grades: { 1: "vivid" },
    };
    const arranged = arrange(clips, choices);
    expect(arranged.map((clip) => [clip.index, clip.at, clip.seconds, clip.grade])).toEqual([
      [1, 0, 3, "vivid"],
      [0, 3, 1, undefined],
    ]);
    expect(arrange([], choices)).toEqual([]);
  });

  it("is what Director reads with a request", () => {
    const state = editorState(
      clips,
      { ...initial, dropped: [1], trims: { 0: { from: 0, to: 2 } } },
      false,
    );
    expect(
      state.shots.map((one) => [one.shotIndex, one.startSeconds, one.endSeconds, one.position]),
    ).toEqual([
      [0, 0, 2, 0],
      [1, 1, 4, null],
      [2, 1, 4, 1],
    ]);
    expect(state).toMatchObject({ captions: "pop", sound: true, music: false, fixes: [] });
  });

  it("fixes words in the captions, whole words only", () => {
    const lines = [{ startSeconds: 0, endSeconds: 1, text: "Cloud is not a cloudy (cloud)" }];
    expect(fixLines(lines, [])).toEqual(lines);
    expect(fixLines(lines, [{ text: "cloud", replacement: "Claude" }])[0]?.text).toBe(
      "Claude is not a cloudy (Claude)",
    );
  });

  it("turns a grade into a filter", () => {
    expect(gradeFilter(undefined)).toBe("none");
    expect(gradeFilter("black-and-white")).toBe("grayscale(1)");
  });
});
