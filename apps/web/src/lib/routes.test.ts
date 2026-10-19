import { describe, expect, it } from "vitest";
import { onStage } from "./routes";

describe("Director's dark stage", () => {
  it("holds Director's own pages, whatever the theme", () => {
    for (const path of ["/library", "/media", "/director/abcdefghijk", "/create/abc"]) {
      expect(onStage(path)).toBe(true);
    }
  });

  it("leaves the rest to the member's theme", () => {
    for (const path of ["/", "/settings", "/sign-in", "/libraryish", "/privacy"]) {
      expect(onStage(path)).toBe(false);
    }
    expect(onStage(null)).toBe(false);
  });
});
