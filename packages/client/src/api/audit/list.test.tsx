import type { AuditEntry } from "@repo/contracts/api";
import { toPage } from "@repo/contracts/pagination";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useAuditLogInfiniteQuery } from "./list";

const entry = (n: number): AuditEntry => ({
  id: id(n),
  name: `event.${n}`,
  occurredAt: new Date(n),
  actor: null,
  payload: {},
});

describe("the audit log", () => {
  it("loads page by page, newest first", async () => {
    const log = [entry(3), entry(2), entry(1)];
    const api = standIn((os) => ({
      audit: {
        list: os.audit.list.handler(({ input }) => {
          const start = input.cursor ? log.findIndex((e) => e.id === input.cursor) + 1 : 0;
          return toPage(log.slice(start), input.limit);
        }),
      },
    }));
    const { result } = renderHook(() => useAuditLogInfiniteQuery(2), api);
    const names = () => result.current.data?.pages.flatMap((p) => p.items.map((e) => e.name));
    await vi.waitFor(() => expect(names()).toEqual(["event.3", "event.2"]));
    await result.current.fetchNextPage();
    await vi.waitFor(() => expect(names()).toEqual(["event.3", "event.2", "event.1"]));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("asks for fifty entries a page by default", async () => {
    const api = standIn((os) => ({
      audit: {
        list: os.audit.list.handler(({ input }) => ({
          items: [{ ...entry(1), name: `limit ${input.limit}` }],
          nextCursor: null,
        })),
      },
    }));
    const { result } = renderHook(() => useAuditLogInfiniteQuery(), api);
    await vi.waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.name).toBe("limit 50"));
  });
});
