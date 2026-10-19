import { videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { renderHook, standIn } from "../../../test/stand-in";
import { useAskEditorMutation } from "./ask";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");

describe("asking Director to change the edit", () => {
  it("sends the request with the edit as it is, and returns Director's answer", async () => {
    const reply = {
      heard: "make it black and white",
      outcome: "applied" as const,
      say: "Done.",
      actions: [],
      choices: [],
    };
    const asked: unknown[] = [];
    const api = standIn((os) => ({
      editor: {
        ask: os.editor.ask.handler(({ input }) => {
          asked.push(input);
          return reply;
        }),
      },
    }));
    const { result } = renderHook(() => useAskEditorMutation(), api);
    const request = {
      videoId,
      text: "make it black and white",
      audio: null,
      audioType: null,
      state: { shots: [], captions: "pop" as const, sound: true, music: false, fixes: [] },
    };
    await expect(result.current.mutateAsync(request)).resolves.toEqual(reply);
    expect(asked).toEqual([request]);
  });
});
