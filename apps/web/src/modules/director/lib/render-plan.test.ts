import { describe, expect, it } from "vitest";
import {
  FADE_SAMPLES,
  FPS,
  mixDown,
  mixInto,
  renderPlan,
  samplesOf,
  segmentAt,
} from "./render-plan";

const RATE = 48_000;
const FRAME = 1 / FPS;

/** The owner's edit: a 7-second take, takes kept for a second or less, and gaps between. */
const OWNERS = [
  { name: "hook", seconds: 7 },
  { name: "gap", seconds: 2 },
  { name: "nod", seconds: 0.7 },
  { name: "gap", seconds: 1.5 },
  { name: "shrug", seconds: 1 },
  { name: "gap", seconds: 2 },
  { name: "blink", seconds: 0.1 },
  { name: "gap", seconds: 1 },
  { name: "close", seconds: 3.4 },
];

describe("the saved video's timeline", () => {
  const plan = renderPlan(OWNERS, (segment) => segment.seconds);

  it("lays every segment end to end in whole frames, the video as long as the edit", () => {
    expect(plan.frames).toBe(Math.round(18.7 * FPS));
    plan.placed.forEach((placed, index) => {
      const before = plan.placed[index - 1];
      expect(placed.firstFrame).toBe(before ? before.firstFrame + before.frames : 0);
      // Within half a frame of where the edit puts it, so nothing drifts.
      const start = OWNERS.slice(0, index).reduce((sum, segment) => sum + segment.seconds, 0);
      expect(Math.abs(placed.firstFrame / FPS - start)).toBeLessThanOrEqual(FRAME / 2);
    });
    // A tenth of a second is three frames.
    expect(plan.placed[6]?.frames).toBe(3);
  });

  it("shows a segment in every frame: a held one is its frame repeated, never one long frame", () => {
    const shown = Array.from({ length: plan.frames }, (_, frame) => segmentAt(plan, frame));
    expect(shown.every((index) => index >= 0)).toBe(true);
    // Each gap is all of its frames, one per 1/30 s.
    expect(shown.filter((index) => index === 1)).toHaveLength(2 * FPS);
    expect(segmentAt(plan, plan.frames)).toBe(-1);
  });

  it("gives each segment exactly the sound its frames last, and the video exactly its picture's length of sound", () => {
    let next = 0;
    for (const placed of plan.placed) {
      const { start, length } = samplesOf(plan, placed, RATE);
      // Starts and ends with its picture, to the sample.
      expect(start).toBe(next);
      expect(Math.abs(start / RATE - placed.firstFrame / FPS)).toBeLessThan(1 / RATE);
      expect(
        Math.abs((start + length) / RATE - (placed.firstFrame + placed.frames) / FPS),
      ).toBeLessThan(1 / RATE);
      next = start + length;
    }
    const whole = samplesOf(plan, { firstFrame: 0, frames: plan.frames }, RATE);
    expect(whole.length).toBe(next);
    expect(whole.length / RATE).toBeCloseTo(plan.frames / FPS, 6);
  });

  it("leaves out a segment too short for a frame, without moving the rest", () => {
    const tiny = renderPlan([1, 0.01, 1, -1], (seconds) => seconds);
    expect(tiny.placed.map((placed) => [placed.segment, placed.firstFrame, placed.frames])).toEqual(
      [
        [1, 0, 30],
        [1, 30, 30],
      ],
    );
    expect(renderPlan([], () => 1)).toEqual({ placed: [], frames: 0, fps: FPS });
  });
});

describe("the soundtrack", () => {
  it("copies a take's part to its place, cut to its length, faded at the cuts", () => {
    const soundtrack = new Float32Array(2000);
    const source = new Float32Array(3000).fill(0.5);
    mixInto(soundtrack, { start: 100, length: 1000, source, from: 500 });
    expect(soundtrack[99]).toBe(0);
    expect(soundtrack[100]).toBe(0);
    expect(soundtrack[100 + FADE_SAMPLES / 2]).toBeCloseTo(0.25);
    expect(soundtrack[600]).toBe(0.5);
    expect(soundtrack[1099]).toBe(0);
    expect(soundtrack[1100]).toBe(0);
  });

  it("is silent where the take's sound runs out before its part does", () => {
    const soundtrack = new Float32Array(100).fill(9);
    mixInto(
      soundtrack,
      { start: 0, length: 100, source: new Float32Array(60).fill(1), from: 20 },
      0,
    );
    expect(soundtrack.slice(0, 40).every((sample) => sample === 1)).toBe(true);
    // Past the take's sound, what was there stays (a fresh soundtrack is silence).
    expect(soundtrack[40]).toBe(9);
    // A part of a sample or two has no room to fade.
    const one = new Float32Array(1);
    mixInto(one, { start: 0, length: 1, source: new Float32Array([0.7]), from: 0 });
    expect(one[0]).toBeCloseTo(0.7);
  });

  it("mixes a take's channels down to one", () => {
    expect([...mixDown([new Float32Array([1, 0]), new Float32Array([0, 1])])]).toEqual([0.5, 0.5]);
    const mono = new Float32Array([0.3]);
    expect(mixDown([mono])).toBe(mono);
    expect(mixDown([])).toHaveLength(0);
    // A channel shorter than the first is silence past its end.
    expect([...mixDown([new Float32Array([1, 1]), new Float32Array([1])])]).toEqual([1, 0.5]);
  });
});
