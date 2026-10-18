import { directorTakeIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { type EditChoices, useEditHistory } from "@/modules/director/hooks/use-edit-history";
import { UNARRANGED } from "@/modules/director/lib/editor-actions";
import { renderHook } from "./support";

const initial: EditChoices = { style: "pop", sound: true, picks: {}, ...UNARRANGED };
const take = directorTakeIdSchema.parse(crypto.randomUUID());

describe("useEditHistory", () => {
  it("undoes and redoes each change, and a new change drops what was undone", async () => {
    const hook = await renderHook(() => useEditHistory(initial));
    expect(hook.current.choices).toEqual(initial);
    expect([hook.current.canUndo, hook.current.canRedo]).toEqual([false, false]);

    hook.current.change({ sound: false });
    await expect.poll(() => hook.current.choices).toEqual({ ...initial, sound: false });
    hook.current.change({ picks: { 0: take } });
    await expect
      .poll(() => hook.current.choices)
      .toEqual({ ...initial, sound: false, picks: { 0: take } });
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

  it("reads the choices as they are now, for an answer that arrives later", async () => {
    const hook = await renderHook(() => useEditHistory(initial));
    // What a request sent now would have seen.
    const asked = hook.current;
    hook.current.change({ picks: { 0: take } });
    await expect.poll(() => hook.current.choices.picks).toEqual({ 0: take });
    expect(asked.now()).toEqual({ ...initial, picks: { 0: take } });
  });

  it("keeps the member's choices in this tab for the next visit, per member and template", async () => {
    window.sessionStorage.clear();
    const key = "member-1:abcdefghijk";
    const first = await renderHook(() => useEditHistory(initial, key));
    first.current.change({ picks: { 0: take }, style: "classic" });
    await expect.poll(() => first.current.choices.style).toBe("classic");
    first.unmount();

    // A reload, or back from reshooting a shot: the same choices.
    const again = await renderHook(() => useEditHistory(initial, key));
    expect(again.current.choices).toEqual({ ...initial, picks: { 0: take }, style: "classic" });
    // Nothing to undo: the visit starts from what was kept.
    expect(again.current.canUndo).toBe(false);
    again.unmount();

    // Another template, or another member, starts afresh.
    const other = await renderHook(() => useEditHistory(initial, "member-2:abcdefghijk"));
    expect(other.current.choices).toEqual(initial);
    other.unmount();

    // A kept value this version can't read is ignored.
    window.sessionStorage.setItem(`director.edit.${key}`, JSON.stringify({ style: "neon" }));
    const unreadable = await renderHook(() => useEditHistory(initial, key));
    expect(unreadable.current.choices).toEqual(initial);
    unreadable.unmount();
    window.sessionStorage.clear();
  });
});
