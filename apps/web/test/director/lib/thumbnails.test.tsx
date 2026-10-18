import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { videoFrames } from "@/modules/director/lib/thumbnails";
import { hue, imageOf, pixel, recordClip } from "./footage";

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
