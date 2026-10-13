import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins class names and lets a later Tailwind class win", () => {
    expect(cn("p-2 text-sm", false && "hidden", "p-4")).toBe("text-sm p-4");
  });
});
