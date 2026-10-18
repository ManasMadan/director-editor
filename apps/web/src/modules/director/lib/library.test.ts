import { describe, expect, it } from "vitest";
import { angleOf, INDEX_STEPS, indexStep, nextShot, shotRhythm } from "./library";

describe("indexStep", () => {
  it("follows the indexing stage, step by step", () => {
    expect(INDEX_STEPS).toEqual(["queued", "watching", "writing", "ready"]);
    expect(indexStep("pending", "queued")).toBe("queued");
    expect(indexStep("analyzing", "watching")).toBe("watching");
    expect(indexStep("analyzing", "writing")).toBe("writing");
    expect(indexStep("ready", "ready")).toBe("ready");
  });

  it("is failed whenever the plan failed, whatever stage it reached", () => {
    expect(indexStep("failed", "failed")).toBe("failed");
    expect(indexStep("failed", "writing")).toBe("failed");
  });

  it("falls back on the status for a stage it doesn't know", () => {
    expect(indexStep("pending", "uploading")).toBe("queued");
    expect(indexStep("analyzing", "thinking")).toBe("watching");
    expect(indexStep("ready", "polishing")).toBe("ready");
    expect(indexStep("unknown", "unknown")).toBe("queued");
  });
});

describe("shotRhythm", () => {
  it("gives each shot its share of the short, in order", () => {
    expect(
      shotRhythm([
        { durationSeconds: 1, kind: "video" },
        { durationSeconds: 3, kind: "photo" },
      ]),
    ).toEqual([
      { share: 0.25, kind: "video" },
      { share: 0.75, kind: "photo" },
    ]);
    expect(shotRhythm([])).toEqual([]);
  });
});

describe("angleOf", () => {
  it("says level within the shot's tolerance, else which way and how far", () => {
    expect(angleOf({ pitch: 4, tolerance: 6 })).toEqual({ tilt: "level", degrees: 0 });
    expect(angleOf({ pitch: 12.4, tolerance: 6 })).toEqual({ tilt: "up", degrees: 12 });
    expect(angleOf({ pitch: -30, tolerance: 10 })).toEqual({ tilt: "down", degrees: 30 });
  });
});

describe("nextShot", () => {
  const shot = (index: number, takes: number) => ({ index, takes: Array.from({ length: takes }) });

  it("is the first shot when nothing is filmed, or every shot is", () => {
    expect(nextShot(undefined)).toEqual({ index: 0, started: false });
    expect(nextShot([shot(0, 0), shot(1, 0)])).toEqual({ index: 0, started: false });
    expect(nextShot([shot(0, 1), shot(1, 2)])).toEqual({ index: 0, started: false });
  });

  it("is the first shot without a take once filming has started", () => {
    expect(nextShot([shot(0, 1), shot(1, 0), shot(2, 0)])).toEqual({ index: 1, started: true });
    expect(nextShot([shot(0, 0), shot(1, 1)])).toEqual({ index: 0, started: true });
  });
});
