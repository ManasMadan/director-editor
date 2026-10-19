import { describe, expect, it } from "vitest";
import { storyboardState } from "./storyboards";

describe("a storyboard card with no drawing", () => {
  it("is still drawing until it fails", () => {
    for (const status of ["pending", "generating", "ready"] as const) {
      expect(storyboardState({ status, error: null })).toBe("drawing");
    }
  });

  it("says why it isn't coming", () => {
    expect(storyboardState({ status: "failed", error: "AI_BUDGET_EXCEEDED" })).toBe("noAllowance");
    expect(storyboardState({ status: "failed", error: "DIRECTOR_IMAGE_LIMIT" })).toBe("dailyLimit");
    expect(storyboardState({ status: "failed", error: "UPSTREAM_UNAVAILABLE" })).toBe("failed");
    expect(storyboardState({ status: "failed", error: null })).toBe("failed");
  });
});
