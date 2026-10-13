import { ORPCError } from "@orpc/client";
import type { RealtimeMessage } from "@repo/contracts/realtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../test/stand-in";
import { useAiDocumentsQuery } from "./api/ai/documents";
import { useFileQuery } from "./api/files/get";
import { useUnreadNotificationsCountQuery } from "./api/notifications/unread-count";
import { useTodoListInfiniteQuery } from "./api/todo/list";
import { useLiveUpdates, useRealtime } from "./realtime";

/**
 * What each stream the client opens does, in order: send its messages and end, fail with
 * a code, never answer, or (past the end of the list) stay open until the client leaves.
 */
type Connection = RealtimeMessage["type"][] | { fails: string } | "silent";

function realtimeApi(connections: Connection[]) {
  let opened = 0;
  const api = standIn((os) => ({
    realtime: {
      // Refusals come before the stream opens, as the API's checks run first.
      subscribe: os.realtime.subscribe.handler(async ({ signal }) => {
        const connection = connections[opened++];
        const aborted = new Promise((resolve) => signal?.addEventListener("abort", resolve));
        if (connection === "silent") {
          await aborted;
        }
        if (typeof connection === "object" && "fails" in connection) {
          throw new ORPCError(connection.fails);
        }
        return (async function* () {
          if (connection === undefined) {
            await aborted;
          } else {
            for (const type of connection as RealtimeMessage["type"][]) {
              yield { type };
            }
          }
        })();
      }),
    },
    todo: {
      list: os.todo.list.handler(() => ({ items: [], nextCursor: null })),
    },
    notifications: { unreadCount: os.notifications.unreadCount.handler(() => ({ count: 0 })) },
    files: {
      get: os.files.get.handler(({ input }) => ({
        id: input.fileId,
        purpose: "avatar",
        status: "ready",
        filename: "me.png",
        contentType: "image/png",
        size: 10,
        rejectReason: null,
        createdAt: new Date(0),
      })),
    },
    ai: { documents: os.ai.documents.handler(() => []) },
  }));
  const streams = () => api.calls.filter((call) => call === "realtime/subscribe").length;
  const count = (procedure: string) => api.calls.filter((call) => call === procedure).length;
  return { api, streams, count };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRealtime", () => {
  it("passes on each message, and reconnects when the stream ends, saying so", async () => {
    const { api, streams } = realtimeApi([["todos.changed", "files.changed"]]);
    const onMessage = vi.fn();
    const onReconnect = vi.fn();
    const { unmount } = renderHook(() => useRealtime(onMessage, onReconnect, "org"), api);
    await until(() => expect(onMessage).toHaveBeenCalledTimes(2));
    expect(onMessage.mock.calls).toEqual([
      [{ type: "todos.changed" }],
      [{ type: "files.changed" }],
    ]);
    expect(onReconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => expect(onReconnect).toHaveBeenCalledOnce());
    expect(streams()).toBe(2);
    unmount();
  });

  it("stops for good when signed out or without a workspace", async () => {
    for (const code of ["UNAUTHENTICATED", "NO_ACTIVE_ORGANIZATION"]) {
      const { api, streams } = realtimeApi([{ fails: code }]);
      renderHook(() => useRealtime(vi.fn(), vi.fn(), "org"), api);
      await until(() => expect(streams()).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(streams()).toBe(1);
    }
  });

  it("retries any other failure, waiting longer each time", async () => {
    const { api, streams } = realtimeApi([{ fails: "INTERNAL" }, { fails: "INTERNAL" }]);
    // No jitter: each wait is the whole backoff.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const onReconnect = vi.fn();
    const { unmount } = renderHook(() => useRealtime(vi.fn(), onReconnect, "org"), api);
    await until(() => expect(streams()).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => expect(streams()).toBe(2));
    // Then two seconds.
    await vi.advanceTimersByTimeAsync(900);
    expect(streams()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_100);
    await until(() => expect(streams()).toBe(3));
    // The first stream that opens isn't a reconnect: nothing was missed before it.
    expect(onReconnect).not.toHaveBeenCalled();
    unmount();
  });

  it("opens nothing without a key, and a new stream when the key changes", async () => {
    const { api, streams } = realtimeApi([]);
    let key: string | null | undefined;
    const { rerender, unmount } = renderHook(() => useRealtime(vi.fn(), vi.fn(), key), api);
    await vi.advanceTimersByTimeAsync(5_000);
    key = null;
    rerender();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(streams()).toBe(0);
    key = "org-1";
    rerender();
    await until(() => expect(streams()).toBe(1));
    key = "org-2";
    rerender();
    await until(() => expect(streams()).toBe(2));
    unmount();
  });

  it("gives up a stream still opening once unmounted", async () => {
    const { api, streams } = realtimeApi(["silent"]);
    const { unmount } = renderHook(() => useRealtime(vi.fn(), vi.fn(), "org"), api);
    await until(() => expect(streams()).toBe(1));
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams()).toBe(1);
  });

  it("stops waiting to reconnect once unmounted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { api, streams } = realtimeApi([{ fails: "INTERNAL" }]);
    const { unmount } = renderHook(() => useRealtime(vi.fn(), vi.fn(), "org"), api);
    await until(() => expect(streams()).toBe(1));
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams()).toBe(1);
  });
});

describe("useLiveUpdates", () => {
  const live = () => {
    useLiveUpdates(id(9));
    useTodoListInfiniteQuery();
    useUnreadNotificationsCountQuery();
    useFileQuery(id(1));
    useAiDocumentsQuery();
  };

  it("refetches what each message says changed, and everything after a reconnect", async () => {
    const messages = realtimeApi([
      ["todos.changed", "notifications.changed", "files.changed", "documents.changed"],
    ]);
    const { count } = messages;
    const { unmount } = renderHook(live, messages.api);
    await until(() => {
      expect(count("todo/list")).toBe(2);
      expect(count("notifications/unreadCount")).toBe(2);
      expect(count("files/get")).toBe(2);
      expect(count("ai/documents")).toBe(2);
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => {
      expect(count("todo/list")).toBe(3);
      expect(count("notifications/unreadCount")).toBe(3);
      expect(count("files/get")).toBe(3);
      expect(count("ai/documents")).toBe(3);
    });
    unmount();
  });
});
