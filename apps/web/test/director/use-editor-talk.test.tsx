import { ORPCError } from "@orpc/client";
import type { EditorReply } from "@repo/contracts/api";
import { directorTakeIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { type EditChoices, useEditHistory } from "@/modules/director/hooks/use-edit-history";
import { useEditorTalk } from "@/modules/director/hooks/use-editor-talk";
import { clipsOf } from "@/modules/director/lib/edit";
import { UNARRANGED } from "@/modules/director/lib/editor-actions";
import { currentUrl } from "../render";
import { deferred, planShot, renderHook, standIn } from "./support";

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

const state = { shots: [], captions: "pop" as const, sound: true, music: false, fixes: [] };

/** The hook on a page of its own, Director's answers what `answer` gives for each request. */
async function talking(
  answer: (input: { text: string | null }) => EditorReply | Promise<EditorReply>,
) {
  const sent: { text: string | null; audio: string | null; audioType: string | null }[] = [];
  const api = standIn((os) => ({
    editor: {
      ask: os.editor.ask.handler(({ input }) => {
        sent.push(input);
        return answer(input);
      }),
    },
  }));
  const replies: (EditorReply | null)[] = [];
  const shown: number[] = [];
  const shots = [planShot({ title: "One" }), planShot({ title: "Two" })];
  const byShot = clipsOf(shots, new Map());
  const hook = await renderHook(
    () => {
      const history = useEditHistory(initial);
      const talk = useEditorTalk("abcdefghijk", "voice", {
        history,
        byShot,
        setReply: (reply) => replies.push(reply),
        showShot: (index) => shown.push(index),
      });
      return { history, talk };
    },
    { api, url: "/director/abcdefghijk/edit" },
  );
  return { hook, sent, replies, shown };
}

const reply = (actions: EditorReply["actions"], outcome: EditorReply["outcome"] = "applied") => ({
  heard: "",
  outcome,
  say: "Done.",
  actions,
  choices: [],
});

describe("Director's answers in the editor", () => {
  it("undoes and redoes as many steps as it says, and takes the member to a reshoot", async () => {
    const queue: EditorReply[] = [
      reply([{ ...nothing, value: null, op: "undo", steps: 2 }]),
      reply([{ ...nothing, value: null, op: "redo" }]),
      reply([{ ...nothing, value: null, op: "reshoot", shotIndex: 1 }]),
    ];
    const { hook, sent } = await talking(() => queue.shift() ?? reply([], "answer"));
    hook.current.history.change({ style: "classic" });
    hook.current.history.change({ sound: false });
    await expect.poll(() => hook.current.history.choices.sound).toBe(false);

    await hook.current.talk.send({ text: "undo the last two" }, state);
    await expect.poll(() => hook.current.history.choices).toEqual(initial);
    await hook.current.talk.send({ text: "put one back" }, state);
    await expect.poll(() => hook.current.history.choices.style).toBe("classic");
    expect(sent[0]).toMatchObject({ text: "undo the last two", audio: null, audioType: null });

    await hook.current.talk.send({ text: "let me film shot two again" }, state);
    await expect.poll(currentUrl).toBe("/director/abcdefghijk/shoot?shot=1&audio=voice&back=edit");
  });

  it("changes nothing for what only Director makes, and shows the shot it brought back", async () => {
    const queue: EditorReply[] = [
      reply([
        { ...nothing, op: "asset_request", value: "a chart of the archetypes" },
        { ...nothing, op: "set_volume", value: "music", level: 0.5 },
      ]),
      reply([{ ...nothing, value: null, op: "restore_shot", shotIndex: 0 }]),
      reply([{ ...nothing, value: null, op: "drop_shot", shotIndex: 1 }], "confirm"),
    ];
    const { hook, replies, shown } = await talking(() => queue.shift() ?? reply([], "answer"));
    await hook.current.talk.send({ text: "make me a chart, and the music lower" }, state);
    await expect.poll(() => replies).toHaveLength(1);
    expect(hook.current.history.choices).toEqual(initial);
    expect(shown).toEqual([]);

    await hook.current.talk.send({ text: "bring the first shot back" }, state);
    await expect.poll(() => shown).toEqual([0]);

    // Asked first: nothing changes until the member says yes.
    const before = hook.current.history.choices;
    await hook.current.talk.send({ text: "cut shot two" }, state);
    await expect.poll(() => replies).toHaveLength(3);
    expect(hook.current.history.choices).toEqual(before);
    expect(hook.current.history.choices.dropped).toEqual([]);
  });

  it("sends a request said out loud as the recording", async () => {
    const { hook, sent } = await talking(() => reply([], "answer"));
    await hook.current.talk.send({ audio: "UklGRg==".repeat(20), audioType: "audio/webm" }, state);
    expect(sent[0]).toMatchObject({ text: null, audioType: "audio/webm" });
  });

  it("says when Director couldn't answer, until it's dismissed", async () => {
    const { hook, replies } = await talking(() => {
      throw new ORPCError("UPSTREAM_UNAVAILABLE");
    });
    await hook.current.talk.send({ text: "warmer" }, state);
    await expect.poll(() => hook.current.talk.error).not.toBeNull();
    expect(replies).toEqual([]);
    hook.current.talk.dismiss();
    await expect.poll(() => hook.current.talk.error).toBeNull();
  });

  it("drops an answer that lands after a newer request's", async () => {
    const slow = deferred<EditorReply>();
    const { hook, replies } = await talking((input) =>
      input.text === "first" ? slow.promise : { ...reply([], "answer"), say: "Second." },
    );
    const first = hook.current.talk.send({ text: "first" }, state);
    await hook.current.talk.send({ text: "second" }, state);
    slow.resolve({ ...reply([], "answer"), say: "First." });
    await first;
    expect(replies.map((answer) => answer?.say)).toEqual(["Second."]);
  });
});
