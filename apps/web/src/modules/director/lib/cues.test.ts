import type { SceneCheck } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import {
  type Cue,
  cuesFor,
  GAP_SECONDS,
  heard,
  logged,
  type Perception,
  pick,
  QUIET_LOG,
  stepLines,
  type Words,
} from "./cues";

const words: Words = {
  greeting: "Hi!",
  offline: "On-device",
  ready: "That's the shot!",
  inPlace: "Great spot!",
  matched: "Pose matched!",
  match: "Match the outline",
  action: "Action!",
  count: (seconds) => `${seconds}`,
  rolling: (seconds) => `Rolling in ${seconds}`,
  light: { "too-dark": "Too dark", "too-bright": "Too bright", backlit: "Backlit" },
  framing: {
    "not-seen": "Step in",
    "come-closer": "Closer",
    "step-back": "Back",
    "step-left": "Left",
    "step-right": "Right",
    "aim-left": "Aim left",
    "aim-right": "Aim right",
  },
  angle: { tipUp: "Tip up", tipDown: "Tip down", leanLeft: "Lean left", leanRight: "Lean right" },
  thing: (seen) => `A ${seen.thing}`,
};

const setup: Perception = {
  phase: "setup",
  paused: false,
  sharing: false,
  micRecording: false,
  countdown: null,
  countdownFrom: 3,
  scene: null,
  offline: false,
  light: null,
  framing: null,
  angle: null,
  posed: null,
  ready: false,
  things: [],
  step: null,
  ideas: [],
};

const scene = (check: Partial<SceneCheck>): SceneCheck => ({
  inPlace: false,
  instruction: "Walk left to the tree",
  direction: "left",
  distanceMeters: 3,
  landmark: null,
  lighting: "good",
  ...check,
});

/** The one cue a perception offers. */
function only(cues: readonly Cue[]): Cue {
  const [first] = cues;
  if (!first) {
    throw new Error("no cue");
  }
  return first;
}

const ids = (cues: readonly Cue[]) => cues.map((each) => each.id);
const said = (cues: readonly Cue[]) => cues.reduce((log, each) => logged(log, each, -5), QUIET_LOG);

describe("Director's voice", () => {
  it("opens with the greeting, then the most important direction", () => {
    const cues = cuesFor(
      { ...setup, light: "too-dark", scene: scene({}), framing: "step-left", angle: "tipUp" },
      words,
    );
    expect(pick(cues, QUIET_LOG, 0)?.id).toBe("greeting");
    const log = said(cues.filter((each) => each.id === "greeting"));
    expect(pick(cues, log, 0)?.text).toBe("Too dark");
    expect(ids(cues)).toEqual([
      "greeting",
      "light:too-dark",
      "scene:Walk left to the tree",
      "framing:step-left",
      "angle:tipUp",
    ]);
  });

  it("takes the light from Gemini until the phone measures it", () => {
    const cues = cuesFor({ ...setup, scene: scene({ lighting: "backlit" }) }, words);
    expect(ids(cues)).toContain("light:backlit");
  });

  it("cheers the spot, the pose, and a shot that's all set", () => {
    expect(ids(cuesFor({ ...setup, scene: scene({ inPlace: true }), posed: true }, words))).toEqual(
      ["greeting", "scene:in-place", "pose:matched"],
    );
    expect(cuesFor({ ...setup, ready: true }, words).map((each) => each.mood)).toEqual([
      "cheer",
      "cheer",
    ]);
  });

  it("asks for the pose once the member is in frame", () => {
    expect(ids(cuesFor({ ...setup, posed: false, framing: "in-frame" }, words))).toContain(
      "pose:match",
    );
    expect(ids(cuesFor({ ...setup, posed: false, framing: "step-back" }, words))).not.toContain(
      "pose:match",
    );
  });

  it("points out things once, and brainstorms the plan's ideas while shown a screen", () => {
    const plant = {
      thing: "plant",
      role: "backdrop",
      score: 0.9,
      box: { x: 0, y: 0, width: 0.2, height: 0.2 },
    } as const;
    const sharing = cuesFor(
      {
        ...setup,
        sharing: true,
        framing: "step-left",
        things: [plant],
        ideas: ["Start wide"],
        offline: true,
      },
      words,
    );
    expect(ids(sharing)).toEqual(["greeting", "thing:plant", "idea:0", "offline"]);
  });

  it("says nothing while paused, or over a take recording the member's voice", () => {
    expect(cuesFor({ ...setup, paused: true }, words)).toEqual([]);
    const step = { index: 0, instruction: "Hold up the top." };
    expect(cuesFor({ ...setup, phase: "recording", micRecording: true, step }, words)).toEqual([]);
    expect(cuesFor({ ...setup, phase: "preview" }, words)).toEqual([]);
  });

  it("counts down and calls each step, each line outranking the one before", () => {
    const three = cuesFor({ ...setup, phase: "countdown", countdown: 3 }, words);
    const one = cuesFor({ ...setup, phase: "countdown", countdown: 1 }, words);
    expect(cuesFor({ ...setup, phase: "countdown" }, words)).toEqual([]);
    const [first] = cuesFor(
      { ...setup, phase: "recording", step: { index: 0, instruction: "Hold up the top." } },
      words,
    );
    const [second] = cuesFor(
      { ...setup, phase: "recording", step: { index: 1, instruction: "Turn around." } },
      words,
    );
    expect(first?.text).toBe("Action! Hold up the top.");
    expect(second?.text).toBe("Turn around.");
    expect(cuesFor({ ...setup, phase: "recording" }, words)).toEqual([]);
    expect(only(three).text).toBe("Rolling in 3");
    expect(only(one).text).toBe("1");
    const priorities = [three, one, [first], [second]].map((cues) => cues[0]?.priority ?? 0);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
    // Back to back, a second apart: each still gets said.
    const counted = logged(QUIET_LOG, only(three), 0);
    expect(pick(one, counted, 1)?.id).toBe("count:1");
  });

  it("waits a breath between lines unless the next matters more", () => {
    const direction = cuesFor({ ...setup, framing: "step-left" }, words).filter(
      (each) => each.id !== "greeting",
    );
    const log = logged(QUIET_LOG, { ...only(direction), id: "other", priority: 6 }, 10);
    expect(pick(direction, log, 11)).toBeNull();
    expect(pick(direction, log, 10 + GAP_SECONDS)?.id).toBe("framing:step-left");
    const urgent = cuesFor({ ...setup, scene: scene({ inPlace: true }) }, words);
    expect(pick(urgent, log, 11)?.id).toBe("greeting");
  });

  it("doesn't repeat a line within its cooldown", () => {
    const cues = cuesFor({ ...setup, framing: "step-left" }, words);
    const log = said(cues);
    expect(pick(cues, log, 0)).toBeNull();
    expect(pick(cues, log, 100)?.id).toBe("framing:step-left");
    expect(pick([], QUIET_LOG, 0)).toBeNull();
  });

  it("lets the member finish before speaking again", () => {
    const cues = cuesFor({ ...setup, framing: "step-left" }, words).filter(
      (each) => each.id !== "greeting",
    );
    const log = heard(QUIET_LOG, 5);
    expect(pick(cues, log, 6)).toBeNull();
    expect(pick(cues, log, 5 + GAP_SECONDS)?.id).toBe("framing:step-left");
  });
});

describe("stepLines", () => {
  it("is each step as Director says it when recording reaches it, the first with Action!", () => {
    const steps = [{ instruction: "Walk in." }, { instruction: "Turn to the camera." }];
    expect(stepLines(steps, words)).toEqual(["Action! Walk in.", "Turn to the camera."]);
    const recording = cuesFor(
      { ...setup, phase: "recording", step: { index: 0, instruction: "Walk in." } },
      words,
    );
    expect(recording.map((cue) => cue.text)).toContain("Action! Walk in.");
  });
});
