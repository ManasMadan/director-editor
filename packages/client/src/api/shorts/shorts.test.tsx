import { ORPCError } from "@orpc/client";
import type { Short, ShortComment, ShortReactions } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { useQueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderHook, standIn, until } from "../../../test/stand-in";
import { errorCode } from "../../errors";
import { useShortCommentsQuery } from "./comments";
import { useShortsFeedInfiniteQuery } from "./feed";
import { useShortQuery } from "./get";
import { useLookupShortMutation } from "./lookup";
import { useReactToShortMutation } from "./react";
import { reacted } from "./reacted";
import { useShortReactionsQuery } from "./reactions";
import { useSavedShortsQuery } from "./saved";

const videoId = (n: number) => videoIdSchema.parse(`video-${String(n).padStart(5, "0")}`);

const short = (n: number): Short => ({
  videoId: videoId(n),
  title: `Short ${n}`,
  channelTitle: "A channel",
  thumbnailUrl: `https://i.ytimg.test/${n}.jpg`,
  durationSeconds: 30,
  viewCount: 100,
  likeCount: null,
  commentCount: 3,
  publishedAt: new Date(n),
});

describe("the Shorts feed", () => {
  it("loads a topic page by page, sending each page's token, until there are no more", async () => {
    const asked: unknown[] = [];
    const api = standIn((os) => ({
      shorts: {
        feed: os.shorts.feed.handler(({ input }) => {
          asked.push(input);
          return input.pageToken === "page-2"
            ? { items: [short(2)], nextPageToken: null }
            : { items: [short(1)], nextPageToken: "page-2" };
        }),
      },
    }));
    const { result } = renderHook(() => useShortsFeedInfiniteQuery("grwm"), api);
    const titles = () => result.current.data?.pages.flatMap((p) => p.items.map((s) => s.title));
    await until(() => expect(titles()).toEqual(["Short 1"]));
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await until(() => expect(titles()).toEqual(["Short 1", "Short 2"]));
    expect(result.current.hasNextPage).toBe(false);
    expect(asked).toEqual([{ topic: "grwm" }, { topic: "grwm", pageToken: "page-2" }]);
  });
});

describe("one short", () => {
  it("is loaded by its id", async () => {
    const api = standIn((os) => ({
      shorts: {
        get: os.shorts.get.handler(({ input }) => ({ ...short(1), videoId: input.videoId })),
      },
    }));
    const { result } = renderHook(() => useShortQuery(videoId(7)), api);
    await until(() => expect(result.current.data).toEqual({ ...short(1), videoId: videoId(7) }));
  });

  it("is not asked for while disabled", () => {
    const api = standIn((os) => ({ shorts: { get: os.shorts.get.handler(() => short(1)) } }));
    const { result } = renderHook(() => useShortQuery(videoId(1), false), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.calls).toEqual([]);
  });
});

describe("finding a short from a link", () => {
  it("sends the link and answers with the short it points at", async () => {
    const api = standIn((os) => ({
      shorts: {
        lookup: os.shorts.lookup.handler(({ input }) => {
          if (input.url !== "https://youtu.be/video-00003") {
            throw new ORPCError("SHORT_NOT_FOUND");
          }
          return short(3);
        }),
      },
    }));
    const { result } = renderHook(() => useLookupShortMutation(), api);
    await expect(
      result.current.mutateAsync({ url: "  https://youtu.be/video-00003 " }),
    ).resolves.toEqual(short(3));
    const error = await result.current
      .mutateAsync({ url: "https://example.com" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("SHORT_NOT_FOUND");
  });
});

describe("a short's comments", () => {
  const comment: ShortComment = {
    id: "c1",
    author: "Someone",
    authorImageUrl: null,
    text: "Love it",
    likeCount: 2,
    publishedAt: new Date(0),
  };

  it("are loaded only once the sheet opens", async () => {
    const api = standIn((os) => ({
      shorts: {
        comments: os.shorts.comments.handler(() => ({ items: [comment], disabled: false })),
      },
    }));
    let open = false;
    const { result, rerender } = renderHook(() => useShortCommentsQuery(videoId(1), open), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.calls).toEqual([]);
    open = true;
    rerender();
    await until(() => expect(result.current.data).toEqual({ items: [comment], disabled: false }));
    expect(api.calls).toEqual(["shorts/comments"]);
  });
});

describe("the saved shorts", () => {
  it("are the member's liked or saved shorts, by kind", async () => {
    const api = standIn((os) => ({
      shorts: {
        saved: os.shorts.saved.handler(({ input }) => (input.kind === "like" ? [short(1)] : [])),
      },
    }));
    const { result } = renderHook(
      () => ({ liked: useSavedShortsQuery("like"), saved: useSavedShortsQuery("save") }),
      api,
    );
    await until(() => expect(result.current.liked.data).toEqual([short(1)]));
    await until(() => expect(result.current.saved.data).toEqual([]));
  });
});

describe("reacted", () => {
  it("turns one reaction on or off and keeps the other", () => {
    const both = { liked: true, saved: true };
    expect(reacted(both, "like", false)).toEqual({ liked: false, saved: true });
    expect(reacted(both, "save", false)).toEqual({ liked: true, saved: false });
    expect(reacted(undefined, "like", true)).toEqual({ liked: true, saved: false });
    expect(reacted(undefined, "save", true)).toEqual({ liked: false, saved: true });
  });
});

describe("reacting to a short", () => {
  /**
   * The member's reactions to short 1. Each `hold()` makes the next change wait until
   * it's released; `refuse` makes changes fail.
   */
  function reactionsApi() {
    let stored: ShortReactions = { liked: false, saved: false };
    const held: PromiseWithResolvers<void>[] = [];
    let refusal: string | undefined;
    const api = standIn((os) => ({
      shorts: {
        reactions: os.shorts.reactions.handler(() => stored),
        react: os.shorts.react.handler(async ({ input }) => {
          await held.shift()?.promise;
          if (refusal) {
            throw new ORPCError(refusal);
          }
          stored = reacted(stored, input.kind, input.on);
          return stored;
        }),
        saved: os.shorts.saved.handler(() => (stored.saved ? [short(1)] : [])),
      },
    }));
    const view = renderHook(
      () => ({
        reactions: useShortReactionsQuery(videoId(1)),
        saved: useSavedShortsQuery("save"),
        react: useReactToShortMutation(),
        queryClient: useQueryClient(),
      }),
      api,
    );
    return {
      ...view,
      api,
      count: (call: string) => api.calls.filter((c) => c === call).length,
      hold: () => {
        const gate = Promise.withResolvers<void>();
        held.push(gate);
        return () => gate.resolve();
      },
      refuse: (code: string) => {
        refusal = code;
      },
    };
  }

  it("shows the change at once, keeps the API's answer and refetches the saved lists", async () => {
    const { result, count, hold } = reactionsApi();
    await until(() =>
      expect(result.current.reactions.data).toEqual({ liked: false, saved: false }),
    );
    await until(() => expect(result.current.saved.data).toEqual([]));
    const release = hold();
    const done = result.current.react.mutateAsync({ videoId: videoId(1), kind: "save", on: true });
    await until(() => expect(result.current.reactions.data).toEqual({ liked: false, saved: true }));
    release();
    await expect(done).resolves.toEqual({ liked: false, saved: true });
    await until(() => expect(result.current.saved.data).toEqual([short(1)]));
    expect(result.current.reactions.data).toEqual({ liked: false, saved: true });
    expect(count("shorts/reactions")).toBe(1);
    expect(count("shorts/saved")).toBe(2);
  });

  it("goes back when the API refuses", async () => {
    const { result, hold, refuse } = reactionsApi();
    await until(() =>
      expect(result.current.reactions.data).toEqual({ liked: false, saved: false }),
    );
    const release = hold();
    refuse("SHORT_NOT_FOUND");
    const done = result.current.react
      .mutateAsync({ videoId: videoId(1), kind: "like", on: true })
      .catch((e: unknown) => e);
    await until(() => expect(result.current.reactions.data).toEqual({ liked: true, saved: false }));
    release();
    expect(errorCode(await done)).toBe("SHORT_NOT_FOUND");
    await until(() =>
      expect(result.current.reactions.data).toEqual({ liked: false, saved: false }),
    );
  });

  it("changes nothing and sends nothing when the change can't even start", async () => {
    const { result, api } = reactionsApi();
    await until(() =>
      expect(result.current.reactions.data).toEqual({ liked: false, saved: false }),
    );
    const failure = new Error("could not stop the reactions' fetch");
    vi.spyOn(result.current.queryClient, "cancelQueries").mockRejectedValueOnce(failure);
    await expect(
      result.current.react.mutateAsync({ videoId: videoId(1), kind: "like", on: true }),
    ).rejects.toBe(failure);
    expect(result.current.reactions.data).toEqual({ liked: false, saved: false });
    expect(api.calls).not.toContain("shorts/react");
  });
});

describe("a short's reactions", () => {
  it("are not asked for while disabled", () => {
    const api = standIn((os) => ({
      shorts: { reactions: os.shorts.reactions.handler(() => ({ liked: true, saved: true })) },
    }));
    const { result } = renderHook(() => useShortReactionsQuery(videoId(1), false), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.calls).toEqual([]);
  });
});
