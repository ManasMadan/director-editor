import { cn } from "./utils";

it("joins classes and lets later Tailwind classes win", () => {
  expect(cn("px-2 text-sm", false, undefined, "px-4")).toBe("text-sm px-4");
});
