import type { DirectorTake, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import {
  clipAt,
  clipsOf,
  complete,
  editLines,
  editSeconds,
  MIN_KEPT_SECONDS,
  playsAsGap,
} from "./edit";
import { FPS, renderPlan, segmentAt } from "./render-plan";

/** Shot 0 is skipped, shot 1 left as a gap, shot 2 filmed. */
const PARTS: Record<number, "filmed" | "gap" | null> = { 0: null, 1: "gap", 2: "filmed" };

const shot = (kind: Shot["kind"], durationSeconds: number, script: Shot["script"] = []): Shot => ({
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
  script,
});

function take(shotIndex: number, overrides: Partial<DirectorTake> = {}): DirectorTake {
  return {
    id: directorTakeIdSchema.parse(crypto.randomUUID()),
    shotIndex,
    fileId: fileIdSchema.parse(crypto.randomUUID()),
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    reason: null,
    chosen: false,
    origin: "shoot",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("the edit", () => {
  const shots = [
    shot("video", 4, [
      { startSeconds: 0, endSeconds: 0.8, text: "Cut" },
      { startSeconds: 1.5, endSeconds: 3, text: "Hi" },
      { startSeconds: 3.2, endSeconds: 4, text: "Past the end" },
    ]),
    shot("photo", 2),
  ];

  it("holds a place for a shot not filmed yet, or still being reviewed", () => {
    const clips = clipsOf(
      shots,
      new Map([[0, take(0, { status: "reviewing", bestStartMs: 1000, bestEndMs: 2000 })]]),
    );
    expect(clips.map((clip) => [clip.state, clip.at, clip.seconds])).toEqual([
      ["reviewing", 0, 4],
      ["missing", 4, 2],
    ]);
    expect(complete(clips)).toBe(false);
    expect(clips[1]?.take).toBeNull();
  });

  it("keeps Gemini's pick of a video, or the whole take, and a photo's time on screen", () => {
    const clips = clipsOf(
      shots,
      new Map([
        [0, take(0, { bestStartMs: 1000, bestEndMs: 3500 })],
        [1, take(1, { kind: "photo", status: "failed" })],
      ]),
    );
    expect(clips.map((clip) => [clip.from, clip.to, clip.at, clip.seconds])).toEqual([
      [1, 3.5, 0, 2.5],
      [0, 2, 2.5, 2],
    ]);
    expect(complete(clips)).toBe(true);
    expect(editSeconds(clips)).toBe(4.5);
    const whole = clipsOf(shots, new Map([[0, take(0)]]));
    expect(whole[0]?.to).toBe(4);
  });

  it("plays the whole take when Gemini kept less than half a second of it", () => {
    // The owner's takes: kept parts of 0.1 s and 0.7 s.
    const clips = clipsOf(
      [shot("video", 4), shot("video", 3)],
      new Map([
        [0, take(0, { bestStartMs: 2000, bestEndMs: 2100 })],
        [1, take(1, { bestStartMs: 500, bestEndMs: 1200 })],
      ]),
    );
    expect(clips.map((clip) => [clip.from, clip.to, clip.seconds])).toEqual([
      [0, 4, 4],
      [0.5, 1.2, expect.closeTo(0.7)],
    ]);
    expect(MIN_KEPT_SECONDS).toBe(0.5);
  });

  it("keeps a shot left as a gap, or not filmed, with no take: a gap, with no captions", () => {
    const script = [{ startSeconds: 0, endSeconds: 2, text: "Over the B-roll" }];
    const clips = clipsOf(
      [shot("video", 2, script), shot("video", 3, script), shot("video", 1)],
      // A gap's take, if one was ever filmed, isn't used.
      new Map([
        [0, take(0)],
        [1, take(1)],
      ]),
      (index) => PARTS[index] ?? null,
    );
    expect(clips.map((clip) => [clip.index, clip.state, clip.take, clip.at, clip.seconds])).toEqual(
      [
        [1, "gap", null, 0, 3],
        [2, "missing", null, 3, 1],
      ],
    );
    expect(clips.map(playsAsGap)).toEqual([true, true]);
    expect(editLines(clips)).toEqual([]);
  });

  it("times each shot's captions to its own frames in the saved video, none over a gap", () => {
    const line = (text: string, end: number) => [{ startSeconds: 0, endSeconds: end, text }];
    // The owner's edit: a 7-second take, gaps between sub-second and short takes.
    const owners = [
      shot("video", 7, line("hook", 6)),
      shot("video", 2, line("gap one", 2)),
      shot("video", 1, line("nod", 0.7)),
      shot("video", 1.5, line("gap two", 1.5)),
      shot("video", 1, line("shrug", 1)),
      shot("video", 4, line("close", 3.4)),
    ];
    const kept = (index: number, startMs: number, endMs: number) =>
      [index, take(index, { bestStartMs: startMs, bestEndMs: endMs })] as const;
    const clips = clipsOf(
      owners,
      new Map([kept(0, 0, 7000), kept(2, 0, 700), kept(4, 0, 1000), kept(5, 0, 3400)]),
      (index) => (index === 1 || index === 3 ? "gap" : "filmed"),
    );
    const lines = editLines(clips);
    expect(lines.map((each) => each.text)).toEqual(["hook", "nod", "shrug", "close"]);
    const plan = renderPlan(clips, (clip) => clip.seconds);
    for (const each of lines) {
      const index = segmentAt(plan, Math.floor(each.startSeconds * FPS));
      const placed = plan.placed[index];
      // The line starts on its own shot's frames and ends by the end of them.
      expect(placed?.segment.shot.script[0]?.text).toBe(each.text);
      const end = ((placed?.firstFrame ?? 0) + (placed?.frames ?? 0)) / FPS;
      expect(each.endSeconds).toBeLessThanOrEqual(end + 1 / FPS / 2);
    }
  });

  it("finds the clip playing at a time, the last one at the end", () => {
    const clips = clipsOf(shots, new Map());
    expect(clipAt(clips, 0)?.index).toBe(0);
    expect(clipAt(clips, 4)?.index).toBe(1);
    expect(clipAt(clips, 6)?.index).toBe(1);
    expect(clipAt([], 0)).toBeUndefined();
  });

  it("captions the edit: each line moved to where its clip plays, cut to the clip", () => {
    const clips = clipsOf(
      [shot("photo", 2), ...shots],
      new Map([
        [0, take(0)],
        [1, take(1, { bestStartMs: 1000, bestEndMs: 3500 })],
        [2, take(2)],
      ]),
    );
    expect(editLines(clips)).toEqual([
      { text: "Hi", startSeconds: 2.5, endSeconds: 4 },
      { text: "Past the end", startSeconds: 4.2, endSeconds: 4.5 },
    ]);
    // Still being reviewed: the script runs from the shot's start. Not filmed: a gap.
    const reviewing = take(0, { status: "reviewing" });
    expect(editLines(clipsOf(shots, new Map([[0, reviewing]])))[0]).toMatchObject({
      text: "Cut",
      startSeconds: 0,
    });
    expect(editLines(clipsOf(shots, new Map()))).toEqual([]);
  });
});
