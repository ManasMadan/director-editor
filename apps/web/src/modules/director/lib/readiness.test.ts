import type { SceneCheck } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { handRaised, isReady, readinessOf } from "./readiness";

const scene = (inPlace: boolean, lighting: SceneCheck["lighting"] = "too-dark"): SceneCheck => ({
  inPlace,
  instruction: "",
  direction: "none",
  distanceMeters: null,
  landmark: null,
  lighting,
});

describe("the ready check", () => {
  it("judges what the shot and device can, and leaves out the rest", () => {
    expect(
      readinessOf({
        landmark: "tree",
        scene: scene(false, "good"),
        offline: false,
        framing: "step-left",
        level: null,
        light: "good",
      }),
    ).toEqual({ spot: "off", frame: "off", angle: "na", light: "ok" });
    expect(
      readinessOf({
        landmark: null,
        scene: null,
        offline: false,
        framing: null,
        level: true,
        light: null,
      }),
    ).toEqual({ spot: "na", frame: "na", angle: "ok", light: "na" });
  });

  it("takes Gemini's light until the phone has measured it, and skips the spot offline", () => {
    const readiness = readinessOf({
      landmark: "tree",
      scene: scene(true),
      offline: true,
      framing: "in-frame",
      level: false,
      light: null,
    });
    expect(readiness).toEqual({ spot: "na", frame: "ok", angle: "off", light: "off" });
  });

  it("goes by Gemini's light when the phone's own reading sees no problem", () => {
    const readiness = readinessOf({
      landmark: null,
      scene: scene(true, "backlit"),
      offline: false,
      framing: null,
      level: null,
      light: "good",
    });
    // The same light the buddy and the voice go by (judgedLight): not ready yet.
    expect(readiness.light).toBe("off");
  });

  it("is ready when everything judged is fine, and only then", () => {
    expect(isReady({ spot: "ok", frame: "ok", angle: "na", light: "ok" })).toBe(true);
    expect(isReady({ spot: "ok", frame: "off", angle: "na", light: "ok" })).toBe(false);
    expect(isReady({ spot: "na", frame: "na", angle: "na", light: "na" })).toBe(false);
  });

  it("sees a hand raised above the head", () => {
    const nose = { x: 0.5, y: 0.3 };
    expect(handRaised({ nose, right_wrist: { x: 0.3, y: 0.2 } })).toBe(true);
    expect(handRaised({ nose, left_wrist: { x: 0.7, y: 0.1 } })).toBe(true);
    expect(handRaised({ nose, left_wrist: { x: 0.7, y: 0.5 } })).toBe(false);
    expect(handRaised({ left_wrist: { x: 0.7, y: 0.1 } })).toBe(false);
    expect(handRaised(null)).toBe(false);
  });
});
