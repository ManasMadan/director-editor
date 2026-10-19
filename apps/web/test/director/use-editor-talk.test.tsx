import type { EditorReply } from "@repo/contracts/api";
import { directorTakeIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { type EditChoices, useEditHistory } from "@/modules/director/hooks/use-edit-history";
import { useEditorTalk } from "@/modules/director/hooks/use-editor-talk";
import { UNARRANGED } from "@/modules/director/lib/editor-actions";
import { deferred, renderHook, standIn } from "./support";

const initial: EditChoices = { style: "pop", sound: true, picks: {}, ...UNARRANGED };
const take = directorTakeIdSchema.parse(crypto.randomUUID());
const nothing = {
  shotIndex: null,
  takeId: null,
  otherShotIndex: null,
  position: null,
  startSeconds: null,
  endSeconds: null,
  level: null,
  text: null,
  replacement: null,
  steps: null,
};

describe("telling Director in the editor", () => {
  it("applies an answer to the choices as they are when it lands", async () => {
    const answer = deferred<EditorReply>();
    const api = standIn((os) => ({
      editor: { ask: os.editor.ask.handler(() => answer.promise) },
    }));
    const hook = await renderHook(
      () => {
        const history = useEditHistory(initial);
        const talk = useEditorTalk("abcdefghijk", "voice", {
          history,
          byShot: [],
          setReply: () => undefined,
          showShot: () => undefined,
        });
        return { history, talk };
      },
      { api },
    );
    const sent = hook.current.talk.send(
      { text: "classic captions" },
      { shots: [], captions: "pop", sound: true, music: false, fixes: [] },
    );
    // While Director thinks, the member picks a take of their own.
    hook.current.history.change({ picks: { 0: take } });
    await expect.poll(() => hook.current.history.choices.picks).toEqual({ 0: take });
    answer.resolve({
      heard: "classic captions",
      outcome: "applied",
      say: "Classic captions it is.",
      actions: [{ ...nothing, op: "captions", value: "classic" }],
      choices: [],
    });
    await sent;
    await expect
      .poll(() => hook.current.history.choices)
      .toEqual({ ...initial, picks: { 0: take }, style: "classic" });
    // One step: undo takes the answer back, and leaves the member's pick.
    hook.current.history.undo();
    await expect
      .poll(() => hook.current.history.choices)
      .toEqual({ ...initial, picks: { 0: take } });
  });
});
