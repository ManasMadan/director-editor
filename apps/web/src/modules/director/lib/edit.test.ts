import type { DirectorTake, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { clipAt, clipsOf, complete, editLines, editSeconds } from "./edit";

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
    // Not filmed yet: the script runs from the shot's start.
    expect(editLines(clipsOf(shots, new Map()))[0]).toMatchObject({ text: "Cut", startSeconds: 0 });
  });
});
