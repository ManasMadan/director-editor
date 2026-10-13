import { describe, expect, it } from "vitest";
import { safeNextPath } from "./use-next-path";

describe("safeNextPath", () => {
  it("keeps paths on this site", () => {
    expect(safeNextPath("/invitations/abc?x=1#y")).toBe("/invitations/abc?x=1#y");
  });

  it.each([
    null,
    "",
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "javascript:alert(1)",
  ])("rejects %s", (next) => {
    expect(safeNextPath(next)).toBe("/dashboard");
  });
});
