import { afterEach, describe, expect, it, vi } from "vitest";
import { lastFrameSeconds } from "@/modules/director/lib/recorded";
import { recordClip } from "./footage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("how much picture a recording holds", () => {
  it("is when its last frame is, in a WebM with no duration written in it", async () => {
    const last = await lastFrameSeconds(await recordClip(1, ["#ff0000"]));
    expect(last).toBeGreaterThan(0.8);
    expect(last).toBeLessThan(1.1);
  });

  it("is none yet when nothing of it can be read", async () => {
    expect(await lastFrameSeconds(new Blob([], { type: "video/webm" }))).toBe(0);
  });

  it("is unknown when no frame shows at its end", { timeout: 15_000 }, async () => {
    vi.spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback").mockReturnValue(0);
    expect(await lastFrameSeconds(await recordClip(0.3, ["#ff0000"]))).toBeNull();
  });
});
