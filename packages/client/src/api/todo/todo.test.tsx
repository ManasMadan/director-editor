import { ORPCError } from "@orpc/client";
import type { Todo } from "@repo/contracts/api";
import { todoIdSchema } from "@repo/contracts/ids";
import { toPage } from "@repo/contracts/pagination";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useTodoCreateMutation } from "./create";
import { useTodoDeleteMutation } from "./delete";
import { useInvalidateTodoListQuery } from "./invalidate-list";
import { useTodoListInfiniteQuery } from "./list";
import { useTodoSetCompletedMutation } from "./set-completed";

const todo = (n: number): Todo => ({
  id: todoIdSchema.parse(id(n)),
  title: `Todo ${n}`,
  completed: false,
  version: 1,
  createdAt: new Date(n),
});

/**
 * An in-memory todo list, newest first. Each `hold()` makes one more change wait until
 * it's released, so a test can look at the list in between; `refuse` makes changes fail.
 */
function todoApi(count: number) {
  let todos = Array.from({ length: count }, (_, i) => todo(count - i));
  const held: PromiseWithResolvers<void>[] = [];
  let refusal: string | undefined;
  const change = async () => {
    await held.shift()?.promise;
    if (refusal) {
      throw new ORPCError(refusal);
    }
  };
  const api = standIn((os) => ({
    todo: {
      list: os.todo.list.handler(({ input }) => {
        const start = input.cursor ? todos.findIndex((t) => t.id === input.cursor) + 1 : 0;
        return toPage(todos.slice(start), input.limit);
      }),
      create: os.todo.create.handler(async ({ input }) => {
        await change();
        const created = { ...todo(100 + todos.length), title: input.title };
        todos = [created, ...todos];
        return created;
      }),
      setCompleted: os.todo.setCompleted.handler(async ({ input }) => {
        await change();
        const found = todos.find((t) => t.id === input.id) as Todo;
        Object.assign(found, { completed: input.completed, version: found.version + 1 });
        return found;
      }),
      delete: os.todo.delete.handler(async ({ input }) => {
        await change();
        todos = todos.filter((t) => t.id !== input.id);
      }),
    },
  }));
  return {
    api,
    lists: () => api.calls.filter((call) => call === "todo/list").length,
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

function renderTodos(server: ReturnType<typeof todoApi>) {
  const view = renderHook(
    () => ({
      list: useTodoListInfiniteQuery(2),
      invalidate: useInvalidateTodoListQuery(),
      create: useTodoCreateMutation(),
      setCompleted: useTodoSetCompletedMutation(),
      remove: useTodoDeleteMutation(),
    }),
    server.api,
  );
  const titles = () =>
    view.result.current.list.data?.pages.flatMap((p) => p.items.map((t) => t.title));
  const item = (n: number) =>
    view.result.current.list.data?.pages.flatMap((p) => p.items).find((t) => t.id === id(n));
  return { ...view, titles, item };
}

describe("the todo list", () => {
  it("loads page by page until there are no more", async () => {
    const server = todoApi(3);
    const { result, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 3", "Todo 2"]));
    expect(result.current.list.hasNextPage).toBe(true);
    await result.current.list.fetchNextPage();
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 3", "Todo 2", "Todo 1"]));
    expect(result.current.list.hasNextPage).toBe(false);
  });

  it("refetches when asked to", async () => {
    const server = todoApi(1);
    const { result, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 1"]));
    await result.current.invalidate();
    expect(server.lists()).toBe(2);
  });
});

describe("creating a todo", () => {
  it("puts it at the top of the list without a refetch", async () => {
    const server = todoApi(1);
    const { result, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 1"]));
    await result.current.create.mutateAsync({ title: "Buy milk" });
    await vi.waitFor(() => expect(titles()).toEqual(["Buy milk", "Todo 1"]));
    expect(server.lists()).toBe(1);
  });
});

describe("completing a todo", () => {
  it("shows it done at once, then settles on the server's version", async () => {
    const server = todoApi(1);
    const { result, item } = renderTodos(server);
    await vi.waitFor(() => expect(item(1)).toMatchObject({ completed: false, version: 1 }));
    const release = server.hold();
    const done = result.current.setCompleted.mutateAsync({
      id: id(1),
      completed: true,
      version: 1,
    });
    await vi.waitFor(() => expect(item(1)).toMatchObject({ completed: true, version: 2 }));
    release();
    await done;
    await vi.waitFor(() => expect(server.lists()).toBe(2));
    expect(item(1)).toMatchObject({ completed: true, version: 2 });
  });

  it("puts it back when the server refuses, and refetches", async () => {
    const server = todoApi(1);
    const { result, item } = renderTodos(server);
    await vi.waitFor(() => expect(item(1)).toMatchObject({ completed: false, version: 1 }));
    server.refuse("TODO_VERSION_CONFLICT");
    await expect(
      result.current.setCompleted.mutateAsync({ id: id(1), completed: true, version: 1 }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(item(1)).toMatchObject({ completed: false, version: 1 }));
    await vi.waitFor(() => expect(server.lists()).toBe(2));
  });

  it("refetches once, after the last of several overlapping changes", async () => {
    const server = todoApi(2);
    const { result, item } = renderTodos(server);
    await vi.waitFor(() => expect(item(2)).toMatchObject({ completed: false, version: 1 }));
    const releaseFirst = server.hold();
    const releaseSecond = server.hold();
    const first = result.current.setCompleted.mutateAsync({
      id: id(2),
      completed: true,
      version: 1,
    });
    const second = result.current.setCompleted.mutateAsync({
      id: id(1),
      completed: true,
      version: 1,
    });
    releaseFirst();
    await first;
    expect(server.lists()).toBe(1);
    releaseSecond();
    await second;
    await vi.waitFor(() => expect(server.lists()).toBe(2));
    await vi.waitFor(() =>
      expect([item(2), item(1)]).toMatchObject([
        { completed: true, version: 2 },
        { completed: true, version: 2 },
      ]),
    );
  });
});

describe("several changes at once", () => {
  it("refetches when they settle together, too", async () => {
    const server = todoApi(2);
    const { result, item, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 2", "Todo 1"]));
    const releaseFirst = server.hold();
    const releaseSecond = server.hold();
    const changes = Promise.all([
      result.current.setCompleted.mutateAsync({ id: id(1), completed: true, version: 1 }),
      result.current.remove.mutateAsync({ id: id(2) }),
    ]);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 1"]));
    releaseFirst();
    releaseSecond();
    await changes;
    await vi.waitFor(() => expect(server.lists()).toBe(2));
    expect(item(1)).toMatchObject({ completed: true, version: 2 });
  });
});

describe("deleting a todo", () => {
  it("removes it at once", async () => {
    const server = todoApi(2);
    const { result, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 2", "Todo 1"]));
    const release = server.hold();
    const removed = result.current.remove.mutateAsync({ id: id(2) });
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 1"]));
    release();
    await removed;
    await vi.waitFor(() => expect(server.lists()).toBe(2));
    expect(titles()).toEqual(["Todo 1"]);
  });

  it("brings it back when the server refuses", async () => {
    const server = todoApi(2);
    const { result, titles } = renderTodos(server);
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 2", "Todo 1"]));
    server.refuse("TODO_NOT_FOUND");
    await expect(result.current.remove.mutateAsync({ id: id(2) })).rejects.toThrow();
    await vi.waitFor(() => expect(titles()).toEqual(["Todo 2", "Todo 1"]));
  });
});
