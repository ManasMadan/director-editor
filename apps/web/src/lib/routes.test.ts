import { describe, expect, it } from "vitest";
import { onStage } from "./routes";

describe("Director's dark stage", () => {
  it("holds every signed-in page, whatever the theme", () => {
    for (const path of [
      "/library",
      "/media",
      "/director/abcdefghijk",
      "/create/abc",
      "/settings",
      "/settings/security",
    ]) {
      expect(onStage(path)).toBe(true);
    }
  });

  it("leaves the public pages to the member's theme", () => {
    for (const path of ["/", "/sign-in", "/libraryish", "/privacy"]) {
      expect(onStage(path)).toBe(false);
    }
    expect(onStage(null)).toBe(false);
  });
});
