import { describe, expect, it } from "vitest";
import { plainPurpose } from "./purpose";

describe("a shot's purpose as the member reads it", () => {
  it("drops the beat's name the plan puts first", () => {
    expect(plainPurpose("hook: introduce the cultural observation, curious and friendly")).toBe(
      "Introduce the cultural observation, curious and friendly",
    );
    expect(plainPurpose("pay-off: the reveal")).toBe("The reveal");
  });

  it("leaves a purpose without one as it is, starting with a capital", () => {
    expect(plainPurpose("Set the scene.")).toBe("Set the scene.");
    expect(plainPurpose("show the result: a clean desk")).toBe("Show the result: a clean desk");
    expect(plainPurpose("Note: keep it short")).toBe("Note: keep it short");
    expect(plainPurpose("")).toBe("");
  });
});
