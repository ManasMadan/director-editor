import type { DirectorTake, MatchCutAlignment, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { clipsOf } from "./edit";
import {
  alignClips,
  cssTransform,
  matchCutInto,
  matchCutsOf,
  moves,
  type PlanLike,
  transformsOf,
} from "./match-cuts";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "./output";
import { applyTransform } from "./stitch";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");

const shot = (kind: Shot["kind"], sourceStartSeconds: number, durationSeconds = 2): Shot => ({
  kind,
  mode: "on-camera",
  title: kind,
  purpose: "p",
  sourceStartSeconds,
  sourceEndSeconds: sourceStartSeconds + durationSeconds,
  durationSeconds,
  camera: "front",
  scene: "s",
  sceneLandmark: null,
  framing: { shotSize: "close-up", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "chest" },
  pose: { description: "d", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Go.", cameraMove: "static" }],
  script: [],
});

const take = (shotIndex: number, bestStartMs: number, bestEndMs: number): DirectorTake => ({
  id: directorTakeIdSchema.parse(crypto.randomUUID()),
  shotIndex,
  fileId: fileIdSchema.parse(crypto.randomUUID()),
  kind: "video",
  status: "ready",
  error: null,
  bestStartMs,
  bestEndMs,
  score: 80,
  feedback: null,
  reason: null,
  chosen: false,
  origin: "shoot",
  createdAt: new Date(),
});

const watch = (startSeconds: number) => ({
  type: "transition",
  startSeconds,
  endSeconds: startSeconds + 0.1,
  transition: "match-cut",
  anchor: " the watch on the left wrist ",
});

const plan: PlanLike & { shots: Shot[] } = {
  shots: [shot("video", 0), shot("video", 2), shot("photo", 4), shot("video", 6)],
  edits: [
    watch(2.2),
    { type: "transition", startSeconds: 4, transition: "whip", anchor: null },
    { type: "text", startSeconds: 6 },
    watch(6),
  ],
};

const aligned = (overrides: Partial<MatchCutAlignment> = {}): MatchCutAlignment => ({
  status: "aligned",
  outgoingEndMs: 1800,
  incomingStartMs: 300,
  transform: { x: -40, y: 25, scale: 0.95, rotation: -2 },
  offsetBeforePx: 61,
  offsetPx: 1.5,
  scaleDiff: 0.002,
  rotationDiff: 0.1,
  cropPercent: 7,
  withinTolerance: true,
  anchor: { x: 0.5, y: 0.5 },
  outgoingFrame: null,
  incomingFrame: null,
  ...overrides,
});

describe("match cuts in the plan", () => {
  it("are the transitions of kind match-cut at a shot's start in the original", () => {
    expect(matchCutInto(plan, 1)).toBe("the watch on the left wrist");
    // A whip, no transition, the first shot and a shot that isn't there.
    expect(matchCutInto(plan, 2)).toBeNull();
    expect(matchCutInto(plan, 0)).toBeNull();
    expect(matchCutInto(plan, 9)).toBeNull();
    expect(matchCutInto(plan, 3)).toBe("the watch on the left wrist");
  });

  it("are none in a plan written before edits, or with an empty anchor", () => {
    expect(matchCutInto({ shots: plan.shots }, 1)).toBeNull();
    expect(
      matchCutInto({ shots: plan.shots, edits: [{ ...watch(2), anchor: " " }] }, 1),
    ).toBeNull();
  });
});

describe("the edit's match cuts", () => {
  const picked = new Map([
    [0, take(0, 200, 2000)],
    [1, take(1, 0, 1500)],
    [3, take(3, 0, 1000)],
  ]);
  const clips = clipsOf(plan.shots, picked);

  it("are asked about once both clips are filmed videos, at the kept parts' ends", () => {
    const cuts = matchCutsOf(videoId, plan, clips);
    // Into shot 4: the shot before is a photo not taken, so there's nothing to line up.
    expect(cuts).toEqual([
      {
        into: 1,
        anchor: "the watch on the left wrist",
        ask: {
          videoId,
          anchor: "the watch on the left wrist",
          outgoing: { takeId: picked.get(0)?.id, atMs: 2000 },
          incoming: { takeId: picked.get(1)?.id, atMs: 0 },
        },
      },
    ]);
  });

  it("move the cut points and the edit's clock to the aligned cut", () => {
    const moved = alignClips(clips, new Map([[1, aligned()]]));
    expect(moved.map((clip) => [clip.from, clip.to, clip.at, clip.seconds])).toEqual([
      [0.2, 1.8, 0, expect.closeTo(1.6)],
      [0.3, 1.5, expect.closeTo(1.6), expect.closeTo(1.2)],
      [0, 2, expect.closeTo(2.8), 2],
      [0, 1, expect.closeTo(4.8), 1],
    ]);
  });

  it("leave a cut that wasn't lined up, or would leave a clip of nothing, as it was", () => {
    const plain = alignClips(clips, new Map([[1, aligned({ status: "not-found" })]]));
    expect(plain.map((clip) => [clip.from, clip.to])).toEqual(
      clips.map((clip) => [clip.from, clip.to]),
    );
    const empty = alignClips(clips, new Map([[1, aligned({ incomingStartMs: 1600 })]]));
    expect(empty[1]).toMatchObject({ from: 0, to: 1.5 });
  });

  it("draw only the aligned clips moved", () => {
    const transforms = transformsOf(
      new Map([
        [1, aligned()],
        [3, aligned({ status: "not-found" })],
      ]),
    );
    expect([...transforms.keys()]).toEqual([1]);
    expect(moves(aligned().transform)).toBe(true);
    expect(moves({ x: 0, y: 0, scale: 1, rotation: 0 })).toBe(false);
  });
});

describe("the transform", () => {
  const transform = { x: 72, y: -64, scale: 0.9, rotation: 10 };

  it("is the same in CSS (shares of the frame) and on the render's canvas", () => {
    expect(cssTransform(transform)).toBe("translate(10%, -5%) rotate(10deg) scale(0.9)");
    // A canvas stand-in that applies each call to a point, as the 2D context does.
    const point = { x: 500, y: 300 };
    const steps: ((p: { x: number; y: number }) => { x: number; y: number })[] = [];
    const ctx = {
      translate: (x: number, y: number) => steps.push((p) => ({ x: p.x + x, y: p.y + y })),
      rotate: (angle: number) =>
        steps.push((p) => ({
          x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
          y: p.x * Math.sin(angle) + p.y * Math.cos(angle),
        })),
      scale: (sx: number, sy: number) => steps.push((p) => ({ x: p.x * sx, y: p.y * sy })),
    };
    applyTransform(ctx, transform);
    // The canvas applies the last call to the point first.
    const drawn = steps.reduceRight((p, step) => step(p), point);
    const angle = (10 * Math.PI) / 180;
    const cx = OUTPUT_WIDTH / 2;
    const cy = OUTPUT_HEIGHT / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    expect(drawn.x).toBeCloseTo(cx + 72 + 0.9 * (dx * Math.cos(angle) - dy * Math.sin(angle)));
    expect(drawn.y).toBeCloseTo(cy - 64 + 0.9 * (dx * Math.sin(angle) + dy * Math.cos(angle)));
  });
});
