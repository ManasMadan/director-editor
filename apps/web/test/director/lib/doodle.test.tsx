import type { SceneCheck, Shot } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DoodleColors,
  type DoodleScene,
  drawDoodles,
  OPEN_BOTTOM,
} from "@/modules/director/lib/doodle";
import { canvasOf } from "./footage";

const WIDTH = 360;
const HEIGHT = 640;
const COLORS: DoodleColors = {
  locked: "#00ff00",
  waiting: "#ffff00",
  ink: "#ffffff",
  shade: "#000000",
};
const SUBJECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.6 };

const shot: Shot = {
  kind: "video",
  title: "Intro",
  purpose: "p",
  sourceStartSeconds: 0,
  sourceEndSeconds: 3,
  durationSeconds: 3,
  camera: "front",
  scene: "By a tree",
  sceneLandmark: "tree",
  framing: { shotSize: "medium", subject: SUBJECT, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "eye" },
  pose: { description: "d", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Go.", cameraMove: "static" }],
  script: [],
};

const scene = (overrides: Partial<DoodleScene> = {}): DoodleScene => ({
  shot,
  target: {},
  matched: false,
  mirrored: false,
  person: null,
  framing: null,
  scene: null,
  move: null,
  labels: { spot: "Stand here", meters: null, move: null },
  ...overrides,
});

const check = (overrides: Partial<SceneCheck> = {}): SceneCheck => ({
  inPlace: false,
  instruction: "Walk left",
  direction: "left",
  distanceMeters: 3,
  landmark: null,
  lighting: "good",
  ...overrides,
});

const TREE = { label: "Tree", box: { x: 0.7, y: 0.2, width: 0.2, height: 0.5 } };

/** A moment the arrows rest at the start of their bob. */
const REST = (Math.PI * 3) / 10;

/**
 * A canvas that notes each line, fill and label it draws, with the pen's colour then.
 * A null `time` draws without one, as a caller with no clock would.
 */
function draw(doodles: DoodleScene, time: number | null = REST) {
  const { ctx } = canvasOf(WIDTH, HEIGHT);
  const strokes: { color: string; dash: number[]; offset: number }[] = [];
  const fills: string[] = [];
  const labels: { text: string; color: string; x: number; y: number }[] = [];
  const stroke = ctx.stroke.bind(ctx);
  const fill = ctx.fill.bind(ctx);
  const fillText = ctx.fillText.bind(ctx);
  vi.spyOn(ctx, "stroke").mockImplementation(() => {
    // The canvas keeps dashes in single precision.
    const dash = ctx.getLineDash().map((length) => Math.round(length * 10) / 10);
    strokes.push({ color: String(ctx.strokeStyle), dash, offset: ctx.lineDashOffset });
    stroke();
  });
  vi.spyOn(ctx, "fill").mockImplementation(() => {
    fills.push(String(ctx.fillStyle));
    fill();
  });
  vi.spyOn(ctx, "fillText").mockImplementation((text, x, y) => {
    labels.push({ text, color: String(ctx.fillStyle), x, y });
    fillText(text, x, y);
  });
  const moveTo = vi.spyOn(ctx, "moveTo");
  const arc = vi.spyOn(ctx, "arc");
  const ellipse = vi.spyOn(ctx, "ellipse");
  const clearRect = vi.spyOn(ctx, "clearRect");
  const pen = { ctx, width: WIDTH, height: HEIGHT };
  if (time === null) {
    Reflect.apply(drawDoodles, undefined, [pen, doodles, COLORS]);
  } else {
    drawDoodles(pen, doodles, COLORS, time);
  }
  return { strokes, fills, labels, moveTo, arc, ellipse, clearRect };
}

const near = (actual: number | undefined, expected: number) =>
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(5);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Director's doodles", () => {
  it("marks the subject's corners and the body to match, in the waiting colour", () => {
    const drawn = draw(
      scene({
        target: {
          nose: { x: 0.25, y: 0.25 },
          left_shoulder: { x: 0.3, y: 0.35 },
          right_shoulder: { x: 0.2, y: 0.35 },
          left_elbow: { x: 0.33, y: 0.45 },
        },
        framing: "come-closer",
      }),
    );
    expect(drawn.clearRect).toHaveBeenCalledWith(0, 0, WIDTH, HEIGHT);
    // Eight corner arms, two bones (the elbow's wrist isn't there), the head and four arrows.
    expect(drawn.strokes).toHaveLength(8 + 2 + 1 + 4);
    expect(new Set(drawn.strokes.map((s) => s.color))).toEqual(new Set([COLORS.waiting]));
    expect(drawn.strokes.every((s) => s.dash.length === 0)).toBe(true);
    expect(drawn.fills).toEqual(Array(4).fill(COLORS.waiting));
    expect(drawn.arc).toHaveBeenCalledOnce();
    expect(drawn.arc.mock.calls[0]?.slice(0, 2)).toEqual([0.25 * WIDTH, 0.25 * HEIGHT]);
    // The first corner arm starts at the box's top left.
    near(drawn.moveTo.mock.calls[0]?.[0], SUBJECT.x * WIDTH);
    expect(drawn.labels).toEqual([]);
  });

  it("locks the outline once matched, mirrored onto the front camera's preview", () => {
    const drawn = draw(
      scene({
        matched: true,
        mirrored: true,
        target: { left_hip: { x: 0.3, y: 0.6 }, right_hip: { x: 0.2, y: 0.6 } },
      }),
    );
    // Corners and the one bone, no head without a nose.
    expect(drawn.strokes).toHaveLength(8 + 1);
    expect(new Set(drawn.strokes.map((s) => s.color))).toEqual(new Set([COLORS.locked]));
    expect(drawn.arc).not.toHaveBeenCalled();
    near(drawn.moveTo.mock.calls[0]?.[0], (1 - SUBJECT.x - SUBJECT.width) * WIDTH);
    near(drawn.moveTo.mock.calls[8]?.[0], (1 - 0.3) * WIDTH);
  });

  it("rings the landmark, marks the spot beside it, and arrows the walk there", () => {
    const drawn = draw(
      scene({
        person: { x: 0.95, y: 0.5 },
        mirrored: true,
        scene: check({ landmark: TREE }),
        labels: { spot: "Stand here", meters: "3 m", move: null },
      }),
    );
    const walk = drawn.strokes.slice(8);
    expect(walk).toMatchObject([
      { color: COLORS.locked, dash: [10, 8] },
      { color: COLORS.waiting, dash: [] },
      { color: COLORS.waiting, dash: [] },
      { color: COLORS.waiting, dash: [18, 18 * 0.8] },
    ]);
    // The ring and the spot.
    expect(drawn.ellipse).toHaveBeenCalledTimes(2);
    expect(drawn.labels.map((label) => [label.text, label.color])).toEqual([
      ["Tree", COLORS.locked],
      ["Stand here", COLORS.waiting],
      ["3 m", COLORS.waiting],
    ]);
    // The feet, mirrored to the frame's left, start the arrow; the spot is right of them.
    near(drawn.moveTo.mock.calls.at(-2)?.[0], 0.05 * WIDTH);
    near(drawn.moveTo.mock.calls.at(-2)?.[1], 0.5 * HEIGHT);
    // The labels' backings, and the arrow's head.
    expect(drawn.fills).toEqual([COLORS.shade, COLORS.shade, COLORS.waiting, COLORS.shade]);
  });

  it("bows the arrow the other way coming from the right, unlabelled with no distance", () => {
    const drawn = draw(
      scene({
        person: { x: 0.95, y: 0.5 },
        scene: check({ direction: "left", landmark: { ...TREE, box: { ...TREE.box, x: 0.1 } } }),
      }),
    );
    expect(drawn.strokes.slice(8).map((s) => s.dash.length > 0)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(drawn.labels.map((label) => label.text)).toEqual(["Tree", "Stand here"]);
    near(drawn.moveTo.mock.calls.at(-2)?.[0], 0.95 * WIDTH);
  });

  it("shows the spot without an arrow once the member is in place", () => {
    const drawn = draw(scene({ scene: check({ inPlace: true, landmark: TREE }) }));
    expect(drawn.strokes.slice(8).map((s) => s.color)).toEqual([
      COLORS.locked,
      COLORS.locked,
      COLORS.locked,
    ]);
    expect(drawn.fills).toEqual([COLORS.shade, COLORS.shade]);
    expect(drawn.labels.map((label) => label.text)).toEqual(["Tree", "Stand here"]);
  });

  it("arrows the way to walk with no landmark seen, from the feet or the frame's middle", () => {
    const fromMiddle = draw(
      scene({
        scene: check({ direction: "right" }),
        labels: { spot: "Stand here", meters: "5 m", move: null },
      }),
    );
    expect(fromMiddle.strokes.slice(8)).toMatchObject([
      { color: COLORS.waiting, dash: [18, 14.4] },
    ]);
    near(fromMiddle.moveTo.mock.calls[8]?.[0], 0.5 * WIDTH);
    near(fromMiddle.moveTo.mock.calls[8]?.[1], OPEN_BOTTOM * HEIGHT);
    expect(fromMiddle.labels).toMatchObject([{ text: "5 m", color: COLORS.waiting }]);
    expect(fromMiddle.labels[0]?.x).toBeCloseTo(0.8 * WIDTH, 0);

    const fromFeet = draw(scene({ person: { x: 0.7, y: 0.4 }, scene: check() }));
    near(fromFeet.moveTo.mock.calls[8]?.[0], 0.7 * WIDTH);
    near(fromFeet.moveTo.mock.calls[8]?.[1], 0.4 * HEIGHT);
    expect(fromFeet.labels).toEqual([]);
  });

  it("draws no walk with nothing to say, or once in place", () => {
    for (const doodles of [
      scene(),
      scene({ scene: check({ direction: "none" }) }),
      scene({ scene: check({ inPlace: true }) }),
    ]) {
      const drawn = draw(doodles);
      expect(drawn.strokes).toHaveLength(8);
      expect(drawn.labels).toEqual([]);
    }
  });

  it("still wobbles the walk from feet far off the frame", () => {
    // Feet left of a laptop camera's 9:16 crop, the arrow resting at the bottom of its bob.
    // Its seed comes to nothing there: the wobble starts its sequence from one instead.
    const drawn = draw(
      scene({ person: { x: -0.7, y: 0.9 }, scene: check({ direction: "forward" }) }),
    );
    const jitter = 0.16 * HEIGHT * 0.015;
    const first = 16_807 / 2_147_483_647 - 0.5;
    const [x, y] = drawn.moveTo.mock.calls[8] ?? [];
    expect(x).toBeCloseTo(-0.7 * WIDTH + first * jitter);
    near(y, OPEN_BOTTOM * HEIGHT);
  });

  it("circles the phone round the subject for an orbit, labelled", () => {
    const drawn = draw(
      scene({ move: "orbit", labels: { spot: "Stand here", meters: null, move: "Orbit" } }),
    );
    // The loop (marching dashes) and its arrow.
    expect(drawn.strokes.slice(8)).toMatchObject([
      { color: COLORS.ink, dash: [16, 16 * 0.8] },
      { color: COLORS.ink, dash: [] },
    ]);
    expect(drawn.ellipse).toHaveBeenCalledOnce();
    expect(drawn.fills).toEqual([COLORS.ink, COLORS.shade]);
    expect(drawn.labels).toMatchObject([{ text: "Orbit", color: COLORS.ink, y: 0.74 * HEIGHT }]);
  });

  it("arrows a straight camera move, and none for holding still", () => {
    const tilt = draw(scene({ move: "tilt-down" }));
    expect(tilt.strokes.slice(8)).toMatchObject([{ color: COLORS.ink, dash: [] }]);
    expect(tilt.fills).toEqual([COLORS.ink]);
    expect(tilt.labels).toEqual([]);
    const still = draw(
      scene({ move: "static", labels: { spot: "Stand here", meters: null, move: "Hold" } }),
    );
    expect(still.strokes).toHaveLength(8);
    expect(still.labels).toEqual([]);
  });

  it("holds the dashes and the spot still in a frame drawn without a clock", () => {
    const doodles = scene({ scene: check({ landmark: TREE }) });
    const moving = draw(doodles, 0.5);
    const still = draw(doodles, null);
    // The landmark's ring: marching with time, at rest without.
    expect(moving.strokes[8]?.offset).toBe(-0.5 * 40);
    expect(still.strokes[8]?.offset).toBe(0);
    // The spot: pulsing with time, its own size without.
    expect(moving.ellipse.mock.calls[1]?.[2]).not.toBeCloseTo(WIDTH * 0.09);
    expect(still.ellipse.mock.calls[1]?.[2]).toBeCloseTo(WIDTH * 0.09);
  });
});
