import type { Shot } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import {
  bob,
  controlOf,
  type DoodleScene,
  flipBody,
  flipBox,
  flipPoint,
  framingArrows,
  glideScene,
  moveArrow,
  OPEN_BOTTOM,
  OPEN_TOP,
  spotBeside,
  stickerAlive,
  walkArrow,
  walkStart,
} from "./doodle";
import { Glider } from "./spring";

describe("doodles", () => {
  it("points an arrow the way each camera move goes, and none for staying still", () => {
    expect(moveArrow("down")).toEqual({
      from: { x: 0.5, y: 0.36 },
      to: { x: 0.5, y: 0.64 },
      bend: 0,
    });
    const left = moveArrow("left");
    expect(left?.to.x).toBeLessThan(left?.from.x ?? 0);
    expect(moveArrow("tilt-up")?.bend).toBeGreaterThan(0);
    expect(moveArrow("static")).toBeNull();
    expect(moveArrow("orbit")).toBeNull();
  });

  it("points the walk from the member's feet the way Director says, within the frame", () => {
    const feet = { x: 0.2, y: 0.8 };
    expect(walkArrow("left", feet)?.to).toEqual({ x: 0.06, y: 0.8 });
    expect(walkArrow("right", feet)?.to.x).toBeCloseTo(0.5);
    expect(walkArrow("forward", feet)?.to.y).toBeGreaterThan(0.8);
    expect(walkArrow("back", feet)?.to.y).toBeLessThan(0.8);
    expect(walkArrow("turn-left", feet)?.to.x).toBeLessThan(
      walkArrow("turn-left", feet)?.from.x ?? 0,
    );
    expect(walkArrow("turn-right", feet)?.to.x).toBeGreaterThan(0.5);
    expect(walkArrow("none", feet)).toBeNull();
  });

  it("marks the spot beside the landmark, towards the middle, in the open band", () => {
    const leftTree = spotBeside({ x: 0.02, y: 0.18, width: 0.28, height: 0.62 });
    expect(leftTree.x).toBeCloseTo(0.4);
    expect(leftTree.y).toBe(OPEN_BOTTOM);
    const rightTree = spotBeside({ x: 0.7, y: 0.05, width: 0.28, height: 0.4 });
    expect(rightTree.x).toBeCloseTo(0.6);
    expect(rightTree.y).toBeCloseTo(0.41);
    // Never under the cards above: a landmark at the top keeps the spot in the open band.
    expect(spotBeside({ x: 0.9, y: 0, width: 0.1, height: 0.1 })).toEqual({ x: 0.8, y: OPEN_TOP });
  });

  it("starts the walk at the member, or far enough off to point the way to go", () => {
    const spot = { x: 0.4, y: 0.6 };
    expect(walkStart({ x: 0.9, y: 0.5 }, spot, "left")).toEqual({ x: 0.9, y: 0.5 });
    // Too near, or not seen: the arrow points the way Director said.
    expect(walkStart({ x: 0.5, y: 0.6 }, spot, "left").x).toBeCloseTo(0.72);
    expect(walkStart(null, spot, "turn-right").x).toBeCloseTo(0.08);
    expect(walkStart(null, spot, "right").y).toBe(OPEN_BOTTOM);
    // Said neither: towards the spot, from the member or the frame's middle.
    const below = walkStart({ x: 0.3, y: 0.9 }, spot, "forward");
    expect(below.x).toBeCloseTo(0.08);
    expect(below.y).toBe(OPEN_BOTTOM);
    expect(walkStart(null, { x: 0.7, y: 0.5 }, "none").x).toBeCloseTo(0.38);
    expect(walkStart(null, { x: 0.5, y: 0.5 }, "back").x).toBeCloseTo(0.18);
  });

  it("flips camera-frame positions onto the front camera's mirrored preview", () => {
    expect(flipPoint({ x: 0.2, y: 0.3 }, true)).toEqual({ x: 0.8, y: 0.3 });
    expect(flipPoint({ x: 0.2, y: 0.3 }, false)).toEqual({ x: 0.2, y: 0.3 });
    expect(flipBox({ x: 0.1, y: 0, width: 0.3, height: 1 }, true).x).toBeCloseTo(0.6);
    expect(flipBody({ nose: { x: 0.25, y: 0.1 } }, true)).toEqual({ nose: { x: 0.75, y: 0.1 } });
  });

  it("draws the framing hint as arrows round the box", () => {
    const box = { x: 0.2, y: 0.1, width: 0.6, height: 0.8 };
    const closer = framingArrows("come-closer", box);
    expect(closer).toHaveLength(4);
    // Pulling out to the corners: each arrow ends further from the middle than it starts.
    const middle = { x: 0.5, y: 0.5 };
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - middle.x, p.y - middle.y);
    expect(closer.every((arrow) => far(arrow.to) > far(arrow.from))).toBe(true);
    expect(framingArrows("step-back", box).every((arrow) => far(arrow.to) < far(arrow.from))).toBe(
      true,
    );
    expect(framingArrows("step-left", box)[0]?.to.x).toBeLessThan(0.5);
    expect(framingArrows("step-right", box)[0]?.to.x).toBeGreaterThan(0.5);
    expect(framingArrows("aim-right", box)[0]?.to.x).toBeGreaterThan(0.5);
    expect(framingArrows("in-frame", box)).toEqual([]);
    expect(framingArrows(null, box)).toEqual([]);
  });

  it("bows a bent arrow off its middle and bobs it along its way", () => {
    expect(controlOf({ from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, bend: 0.1 })).toEqual({
      x: 0.5,
      y: 0.1,
    });
    expect(controlOf({ from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 }, bend: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    const arrow = { from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, bend: 0 };
    const moved = bob(arrow, Math.PI / 10);
    expect(moved.from.x).toBeGreaterThan(0.2);
    expect(moved.from.y).toBe(0.5);
    expect(bob(arrow, -Math.PI / 10).from.x).toBeCloseTo(0.2);
    // An arrow with no length has no way to go: it stays put.
    const dot = { from: { x: 0.3, y: 0.3 }, to: { x: 0.3, y: 0.3 }, bend: 0 };
    expect(bob(dot, 1)).toEqual(dot);
  });

  it("keeps a sticker for its life, then lets it go", () => {
    const star = { id: 1, kind: "star", born: 10, at: { x: 0.5, y: 0.5 }, label: "" } as const;
    expect(stickerAlive(star, 11)).toBe(true);
    expect(stickerAlive(star, 12)).toBe(false);
  });

  it("glides the tracked positions towards each new reading", () => {
    const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    const scene = (x: number) =>
      ({
        person: { x, y: 0.8 },
        scene: {
          inPlace: false,
          instruction: "",
          direction: "none",
          distanceMeters: null,
          lighting: "good",
          landmark: { label: "tree", box: { ...box, x } },
        },
        highlights: [{ key: "cup", label: "cup", box: { ...box, x } }],
      }) as const;
    const glider = new Glider();
    glider.frame(0);
    const first = glideScene(fill(scene(0.1)), glider);
    expect(first.person?.x).toBeCloseTo(0.1);
    glider.frame(1 / 30);
    const next = glideScene(fill(scene(0.6)), glider);
    for (const x of [next.person?.x, next.scene?.landmark?.box.x, next.highlights[0]?.box.x]) {
      expect(x).toBeGreaterThan(0.1);
      expect(x).toBeLessThan(0.6);
    }
    const none = glideScene(fill({ person: null, scene: null, highlights: [] }), glider);
    expect(none.person).toBeNull();
    expect(none.scene).toBeNull();
  });
});

const SHOT: Shot = {
  kind: "video",
  title: "t",
  purpose: "p",
  sourceStartSeconds: 0,
  sourceEndSeconds: 1,
  durationSeconds: 1,
  camera: "back",
  scene: "s",
  sceneLandmark: null,
  framing: { shotSize: "medium", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "eye" },
  pose: { description: "d", keypoints: [] },
  steps: [],
  script: [],
};

/** A scene with only what gliding reads; the rest is never looked at. */
function fill(part: Pick<DoodleScene, "person" | "scene" | "highlights">): DoodleScene {
  return {
    shot: SHOT,
    target: {},
    matched: false,
    mirrored: false,
    framing: null,
    move: null,
    recording: false,
    subject: true,
    still: false,
    horizon: null,
    stickers: [],
    labels: { spot: "", meters: null, move: null },
    ...part,
  };
}
