import { describe, expect, it } from "vitest";
import { type EditChoices, useEditHistory } from "@/modules/director/hooks/use-edit-history";
import { renderHook } from "./support";

const initial: EditChoices = { style: "pop", texts: {}, sound: true };

describe("useEditHistory", () => {
  it("undoes and redoes each change, and a new change drops what was undone", async () => {
    const hook = await renderHook(() => useEditHistory(initial));
    expect(hook.current.choices).toEqual(initial);
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([false, false]);

    hook.current.change({ sound: false });
    await expect.poll(() => hook.current.choices).toEqual({ ...initial, sound: false });
    hook.current.change({ texts: { "0:0": "Hello" } });
    await expect
      .poll(() => hook.current.choices)
      .toEqual({ ...initial, sound: false, texts: { "0:0": "Hello" } });
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([true, false]);

    hook.current.undo();
    await expect.poll(() => hook.current.choices).toEqual({ ...initial, sound: false });
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([true, true]);
    hook.current.undo();
    await expect.poll(() => hook.current.choices).toEqual(initial);
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([false, true]);

    hook.current.redo();
    await expect.poll(() => hook.current.choices).toEqual({ ...initial, sound: false });

    hook.current.change({ sound: true });
    await expect.poll(() => hook.current.choices).toEqual(initial);
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([true, false]);
  });
});
