import { EMPTY_VERSION, type YourVersion } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { renderHook, standIn, until } from "../../../test/stand-in";
import { useReviseMutation } from "./revise";
import { useSaveYourVersionMutation } from "./save-your-version";
import { useYourVersionQuery } from "./your-version";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");
const inside: YourVersion = { ...EMPTY_VERSION, notes: [{ kind: "place", note: "Inside" }] };

describe("the member's version", () => {
  it("keeps a save made during a re-plan until the re-plan has landed, so it's the last word", async () => {
    const replanned = Promise.withResolvers<void>();
    const order: string[] = [];
    const api = standIn((os) => ({
      yourVersion: {
        revise: os.yourVersion.revise.handler(async () => {
          order.push("revise started");
          await replanned.promise;
          order.push("revise saved");
          return { version: inside, summary: "Inside now." };
        }),
        save: os.yourVersion.save.handler(({ input }) => {
          order.push("save");
          return input.version;
        }),
      },
    }));
    const { result } = renderHook(
      () => ({ revise: useReviseMutation(videoId), save: useSaveYourVersionMutation(videoId) }),
      api,
    );
    const revising = result.current.revise.mutateAsync({
      videoId,
      instruction: "inside",
      version: EMPTY_VERSION,
    });
    await until(() => expect(order).toEqual(["revise started"]));
    const saving = result.current.save.mutateAsync({ videoId, version: inside });
    // Time for the save to reach the API, if it were going to go ahead.
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    replanned.resolve();
    await Promise.all([revising, saving]);
    expect(order).toEqual(["revise started", "revise saved", "save"]);
  });
});

describe("the member's version, read", () => {
  it("is read once when the screen opens", async () => {
    const version = { ...EMPTY_VERSION, notes: [{ kind: "place" as const, note: "Kitchen" }] };
    const api = standIn((os) => ({
      yourVersion: {
        get: os.yourVersion.get.handler(({ input }) => {
          expect(input).toEqual({ videoId });
          return version;
        }),
      },
    }));
    const { result } = renderHook(() => useYourVersionQuery(videoId), api);
    await until(() => expect(result.current.data).toEqual(version));
    expect(api.calls).toEqual(["yourVersion/get"]);
  });
});
