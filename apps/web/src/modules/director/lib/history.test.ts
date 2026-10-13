import { describe, expect, it } from "vitest";
import { historyOf, push, redo, undo } from "./history";

describe("undo and redo", () => {
  it("steps back and forward through the choices, and a new one drops what was undone", () => {
    const start = push(push(historyOf("a"), "b"), "c");
    expect(start.now).toBe("c");
    const back = undo(undo(start));
    expect(back.now).toBe("a");
    expect(undo(back)).toBe(back);
    const forward = redo(back);
    expect(forward.now).toBe("b");
    expect(redo(redo(forward)).now).toBe("c");
    expect(redo(redo(redo(forward)))).toEqual(redo(redo(forward)));
    const branched = push(forward, "d");
    expect(branched).toEqual({ past: ["a", "b"], now: "d", future: [] });
  });
});
