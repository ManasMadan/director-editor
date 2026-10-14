import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { soundPeaks, videoFrames } from "@/modules/director/lib/thumbnails";
import { hue, imageOf, pixel, recordClip, wavOf } from "./footage";

let take: string;

beforeAll(async () => {
  // Red for its first half, blue for the rest.
  take = URL.createObjectURL(await recordClip(1.2, ["#ff0000", "#0000ff"]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a take's frames", () => {
  it("takes a 9:16 thumbnail at each time asked", async () => {
    const frames = await videoFrames(take, [0.2, 1]);
    expect(frames.map((frame) => frame.seconds)).toEqual([0.2, 1]);
    const colors = [];
    for (const frame of frames) {
      expect(frame.src).toMatch(/^data:image\/jpeg;base64,/);
      const image = await imageOf(frame.src);
      expect([image.naturalWidth, image.naturalHeight]).toEqual([72, 128]);
      colors.push(hue(pixel(image, 72, 128, 36, 64)));
    }
    expect(colors).toEqual(["red", "blue"]);
  });

  it("fails on a take the browser can't read", async () => {
    const broken = URL.createObjectURL(new Blob(["not a video"], { type: "video/webm" }));
    await expect(videoFrames(broken, [0])).rejects.toThrow("the take couldn't be read");
  });

  it("fails with no canvas to draw on", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(videoFrames(take, [0])).rejects.toThrow("no canvas to draw on");
  });
});

describe("a take's sound", () => {
  it("is bars of its loudness over the part asked for", async () => {
    // One second loud, then one second at under a third of it.
    const rate = 8000;
    const samples = Array.from(
      { length: rate * 2 },
      (_, at) => Math.sin(at / 3) * (at < rate ? 0.8 : 0.24),
    );
    const bars = await soundPeaks(wavOf(samples, rate), 0, 2, 4);
    expect(bars?.map((bar) => Math.round(bar * 10) / 10)).toEqual([1, 1, 0.3, 0.3]);
    const lateHalf = await soundPeaks(wavOf(samples, rate), 1, 2, 2);
    // Against the loudest of that part alone.
    expect(lateHalf).toHaveLength(2);
    expect(lateHalf?.every((bar) => bar > 0.8)).toBe(true);
  });

  it("is none for a take with no sound", async () => {
    expect(await soundPeaks(new Blob(["no sound here"]), 0, 1, 4)).toBeNull();
  });
});
