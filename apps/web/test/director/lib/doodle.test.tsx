/**
 * Director's doodles drawn on a real canvas: which marks, words and stickers each moment
 * puts on the frame, in which colours. The look itself (the wobble, the boil) is checked
 * by its geometry in the unit tests beside lib/sketch.ts.
 */
import type { SceneCheck, Shot } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DoodleColors,
  type DoodleScene,
  drawDoodles,
  type Sticker,
} from "@/modules/director/lib/doodle";
import { canvasOf } from "./footage";

const WIDTH = 360;
const HEIGHT = 640;
const COLORS: DoodleColors = {
  locked: "#00ff00",
  waiting: "#ffff00",
  ink: "#ffffff",
  shade: "#000000",
  pop: "#ffcc00",
  paper: "#fafafa",
  record: "#ff0000",
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
  light: null,
  guided: false,
  move: null,
  recording: false,
  subject: true,
  still: false,
  horizon: null,
  highlights: [],
  stickers: [],
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
const BODY = {
  nose: { x: 0.25, y: 0.25 },
  left_shoulder: { x: 0.3, y: 0.35 },
  right_shoulder: { x: 0.2, y: 0.35 },
  left_elbow: { x: 0.33, y: 0.45 },
};

const sticker = (kind: Sticker["kind"], born: number, label = ""): Sticker => ({
  id: 1,
  kind,
  born,
  at: { x: 0.5, y: 0.4 },
  label,
});

/** A canvas that notes each line's colour (and how faded), each fill's, and each word it writes. */
function draw(doodles: DoodleScene, time = 1) {
  const { ctx } = canvasOf(WIDTH, HEIGHT);
  const strokes: string[] = [];
  const alphas: number[] = [];
  const fills: string[] = [];
  const words: { text: string; color: string }[] = [];
  const stroke = ctx.stroke.bind(ctx);
  const fill = ctx.fill.bind(ctx);
  const fillText = ctx.fillText.bind(ctx);
  vi.spyOn(ctx, "stroke").mockImplementation(() => {
    strokes.push(String(ctx.strokeStyle));
    alphas.push(ctx.globalAlpha);
    stroke();
  });
  vi.spyOn(ctx, "fill").mockImplementation(() => {
    fills.push(String(ctx.fillStyle));
    fill();
  });
  vi.spyOn(ctx, "fillText").mockImplementation((text, x, y) => {
    words.push({ text, color: String(ctx.fillStyle) });
    fillText(text, x, y);
  });
  const clearRect = vi.spyOn(ctx, "clearRect");
  const arc = vi.spyOn(ctx, "arc");
  drawDoodles({ ctx, width: WIDTH, height: HEIGHT, font: "sans-serif" }, doodles, COLORS, time);
  return { strokes, alphas, fills, words, clearRect, arc, ctx };
}

const texts = (drawn: ReturnType<typeof draw>) => drawn.words.map((word) => word.text);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Director's doodles", () => {
  it("draws the buddy to copy in one pen line, smiling, with no words", () => {
    const drawn = draw(scene({ target: BODY, framing: "come-closer" }));
    expect(drawn.clearRect).toHaveBeenCalledWith(0, 0, WIDTH, HEIGHT);
    // Its head and two dot eyes; one line, no dark edge drawn under it.
    expect(drawn.arc).toHaveBeenCalledTimes(3);
    expect(drawn.fills).toEqual([COLORS.ink]);
    expect(new Set(drawn.strokes)).toEqual(new Set([COLORS.ink, COLORS.waiting]));
    expect(drawn.words).toEqual([]);
  });

  it("blinks now and then, and keeps its eyes open with reduced motion", () => {
    expect(draw(scene({ target: BODY }), 3.45).fills).toEqual([]);
    expect(draw(scene({ target: BODY, still: true }), 3.45).fills).toEqual([COLORS.ink]);
  });

  it("cheers in the locked colour once matched, faded back while recording", () => {
    const drawn = draw(scene({ matched: true, mirrored: true, recording: true, target: BODY }));
    // Happy ^ ^ eyes are lines, so nothing is filled.
    expect(drawn.fills).toEqual([]);
    expect(new Set(drawn.strokes)).toEqual(new Set([COLORS.locked]));
    expect(new Set(drawn.alphas)).toEqual(new Set([0.55]));
    const setUp = draw(scene({ matched: true, target: BODY }));
    expect(new Set(setUp.alphas)).toEqual(new Set([1]));
  });

  it("looks around with a ? while it can't see the member", () => {
    // Still or moving, and on the left or (mirrored) right of the frame.
    for (const [still, mirrored] of [
      [false, false],
      [true, true],
    ]) {
      const drawn = draw(scene({ target: BODY, framing: "not-seen", still, mirrored }));
      expect(drawn.words).toEqual([{ text: "?", color: COLORS.ink }]);
    }
  });

  it("worries when the light needs fixing, with a sun by its head", () => {
    const drawn = draw(scene({ target: BODY, light: "too-dark", framing: "not-seen" }));
    expect(drawn.strokes).toContain(COLORS.pop);
    // The light comes first: no "?" on top of the worry.
    expect(drawn.words).toEqual([]);
    expect(draw(scene({ target: BODY, light: "good" })).strokes).not.toContain(COLORS.pop);
  });

  it("draws a buddy without a head when the plan gives none, and no face", () => {
    const drawn = draw(
      scene({
        target: {
          left_hip: { x: 0.3, y: 0.6 },
          right_hip: { x: 0.2, y: 0.6 },
          left_knee: { x: 0.3, y: 0.75 },
        },
        framing: "not-seen",
      }),
    );
    expect(drawn.arc).not.toHaveBeenCalled();
    expect(drawn.words).toEqual([]);
    expect(drawn.strokes).toContain(COLORS.ink);
  });

  it("draws only the walk while it walks the member to their spot, the buddy once there", () => {
    const thing = { key: "cup", label: "cup", box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
    const walk = draw(scene({ target: BODY, highlights: [thing], scene: check(), guided: true }));
    expect(walk.arc).not.toHaveBeenCalled();
    expect(walk.words).toEqual([]);
    expect(new Set(walk.strokes)).toEqual(new Set([COLORS.waiting]));
    const there = draw(
      scene({ target: BODY, highlights: [thing], scene: check({ inPlace: true }), guided: true }),
    );
    expect(there.strokes).toContain(COLORS.ink);
    expect(texts(there)).toEqual(["cup"]);
    // Gemini out of reach, or its checks spent: its last direction no longer hides the buddy.
    const unguided = draw(scene({ target: BODY, highlights: [thing], scene: check() }));
    expect(new Set(unguided.strokes)).toEqual(new Set([COLORS.ink, COLORS.waiting, COLORS.pop]));
    expect(texts(unguided)).toEqual(["cup"]);
  });

  it("gives the buddy round hands, and draws it where the mirrored preview shows the pose", () => {
    const hands = { ...BODY, left_wrist: { x: 0.34, y: 0.55 }, right_wrist: { x: 0.16, y: 0.55 } };
    const drawn = draw(scene({ target: hands, mirrored: true }));
    // Head, two hands, two eyes.
    expect(drawn.arc).toHaveBeenCalledTimes(5);
    const [x] = drawn.arc.mock.calls[0] ?? [];
    expect(Math.abs((x ?? 0) - (1 - BODY.nose.x) * WIDTH)).toBeLessThan(1);
  });

  it("leaves the canvas as it found it: no shadow, fade or dashes carried over", () => {
    const { ctx } = draw(
      scene({
        target: BODY,
        light: "too-dark",
        recording: true,
        horizon: { roll: 8, level: false },
        stickers: [sticker("cut", 0.95, "Cut!")],
      }),
    );
    expect([ctx.shadowBlur, ctx.globalAlpha, ctx.getLineDash()]).toEqual([0, 1, []]);
  });

  it("holds the buddy still with reduced motion: no breath, hop or wobble", () => {
    const at = (time: number) =>
      draw(scene({ target: BODY, matched: true, still: true }), time).arc.mock.calls;
    expect(at(1.3)).toEqual(at(2.9));
  });

  it("puts the sun high in the frame for a shot without a buddy", () => {
    const drawn = draw(scene({ light: "backlit" }));
    expect(new Set(drawn.strokes)).toEqual(new Set([COLORS.waiting, COLORS.pop]));
  });

  it("lassos where a shot without a body goes, and draws nothing of it while sharing", () => {
    const shoes = draw(scene());
    expect(shoes.strokes).toContain(COLORS.waiting);
    const sharing = draw(scene({ subject: false }));
    expect(sharing.strokes).toEqual([]);
  });

  it("lassos the landmark, tags the spot beside it, and arrows the walk there", () => {
    const drawn = draw(
      scene({
        person: { x: 0.95, y: 0.5 },
        mirrored: true,
        scene: check({ landmark: TREE }),
        labels: { spot: "Stand here", meters: "3 m", move: null },
      }),
    );
    expect(texts(drawn)).toEqual(["Tree", "Stand here", "3 m"]);
    // Tags are dark writing on the label stock.
    expect(new Set(drawn.words.map((word) => word.color))).toEqual(new Set([COLORS.shade]));
    expect(drawn.fills).toContain(COLORS.paper);
    expect(drawn.strokes).toContain(COLORS.locked);
  });

  it("bows the walk the other way from the right, unlabelled with no distance", () => {
    const drawn = draw(
      scene({
        person: { x: 0.95, y: 0.5 },
        scene: check({ landmark: { ...TREE, box: { ...TREE.box, x: 0.1 } } }),
      }),
    );
    expect(texts(drawn)).toEqual(["Tree", "Stand here"]);
  });

  it("shows the spot without an arrow once the member is in place", () => {
    const drawn = draw(scene({ subject: false, scene: check({ inPlace: true, landmark: TREE }) }));
    expect(texts(drawn)).toEqual(["Tree", "Stand here"]);
    expect(drawn.strokes).not.toContain(COLORS.waiting);
  });

  it("arrows the way to walk with no landmark, labelled with the distance", () => {
    const labelled = draw(
      scene({
        scene: check({ direction: "right" }),
        labels: { spot: "Stand here", meters: "5 m", move: null },
      }),
    );
    expect(texts(labelled)).toEqual(["5 m"]);
    const fromFeet = draw(scene({ person: { x: 0.7, y: 0.4 }, scene: check() }));
    expect(fromFeet.words).toEqual([]);
    expect(fromFeet.strokes).toContain(COLORS.waiting);
  });

  it("draws no walk with nothing to say, or once in place", () => {
    for (const doodles of [
      scene({ subject: false, scene: check({ direction: "none" }) }),
      scene({ subject: false, scene: check({ inPlace: true }) }),
    ]) {
      const drawn = draw(doodles);
      expect(drawn.strokes).toEqual([]);
      expect(drawn.words).toEqual([]);
    }
  });

  it("circles the phone round the subject for an orbit, labelled", () => {
    const drawn = draw(
      scene({ subject: false, move: "orbit", labels: { spot: "", meters: null, move: "Orbit" } }),
    );
    expect(texts(drawn)).toEqual(["Orbit"]);
    expect(new Set(drawn.strokes)).toEqual(new Set([COLORS.ink]));
  });

  it("arrows a straight camera move, holding still with reduced motion, and none for none", () => {
    const tilt = draw(scene({ subject: false, still: true, move: "tilt-down" }));
    expect(tilt.strokes).toContain(COLORS.ink);
    expect(tilt.words).toEqual([]);
    const still = draw(
      scene({ subject: false, move: "static", labels: { spot: "", meters: null, move: "Hold" } }),
    );
    expect(still.strokes).toEqual([]);
    expect(still.words).toEqual([]);
  });

  it("lassos and names what's worth using in the frame", () => {
    const drawn = draw(
      scene({
        subject: false,
        mirrored: true,
        highlights: [
          { key: "cup", label: "cup", box: { x: 0.1, y: 0.02, width: 0.2, height: 0.2 } },
          { key: "dog", label: "dog", box: { x: 0.6, y: 0.5, width: 0.3, height: 0.3 } },
        ],
      }),
    );
    expect(texts(drawn)).toEqual(["cup", "dog"]);
    expect(drawn.strokes).toContain(COLORS.pop);
  });

  it("draws a horizon to level, solid once level", () => {
    const off = draw(scene({ subject: false, horizon: { roll: 8, level: false } }));
    expect(off.strokes).toContain(COLORS.waiting);
    const level = draw(scene({ subject: false, horizon: { roll: 0, level: true } }));
    expect(level.strokes).toContain(COLORS.locked);
  });

  it("pops each sticker in, and lets it go at the end of its life", () => {
    const drawn = draw(
      scene({
        subject: false,
        stickers: [
          sticker("star", 0.8),
          sticker("nailed", 0.9, "Nailed it!"),
          sticker("clap", 0.7, "Take 2"),
          sticker("cut", 0.95, "Cut!"),
        ],
      }),
    );
    expect(texts(drawn)).toEqual(["Nailed it!", "Take 2", "Cut!"]);
    expect(drawn.fills).toContain(COLORS.pop);
    // Not landed yet, or long gone: nothing.
    const none = draw(
      scene({ subject: false, stickers: [sticker("star", 5), sticker("cut", -10, "Cut!")] }),
    );
    expect(none.fills).toEqual([]);
    expect(none.words).toEqual([]);
  });
});
