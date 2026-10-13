import { todoIdSchema } from "@repo/contracts/ids";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { id } from "../../../test/stand-in";
import type { TodoListData } from "./list";
import { applyCreate, applyDelete, applySetCompleted, restoreTodoLists } from "./optimistic";

const ids = { a: 1, b: 2, c: 3, new: 4 };
const todoId = (name: keyof typeof ids) => todoIdSchema.parse(id(ids[name]));
const todo = (name: keyof typeof ids, completed = false) => ({
  id: todoId(name),
  title: name,
  completed,
  version: 1,
  createdAt: new Date(0),
});
const data: TodoListData = {
  pages: [
    { items: [todo("a"), todo("b")], nextCursor: "b" },
    { items: [todo("c")], nextCursor: null },
  ],
  pageParams: [undefined, "b"],
};

describe("optimistic todo updates", () => {
  it("completes the right item on any page and bumps its version", () => {
    const next = applySetCompleted(data, todoId("c"), true);
    expect(next?.pages[1]?.items[0]).toMatchObject({ title: "c", completed: true, version: 2 });
    expect(next?.pages[0]?.items.every((item) => !item.completed)).toBe(true);
  });

  it("removes an item and prepends a new one to the first page", () => {
    expect(applyDelete(data, todoId("a"))?.pages[0]?.items.map((item) => item.title)).toEqual([
      "b",
    ]);
    expect(applyCreate(data, todo("new"))?.pages[0]?.items.map((item) => item.title)).toEqual([
      "new",
      "a",
      "b",
    ]);
  });

  it("leaves an empty cache empty", () => {
    expect(applySetCompleted(undefined, todoId("a"), true)).toBeUndefined();
  });
});

describe("restoring the lists after a failed change", () => {
  it("puts back every list saved, and leaves the cache alone when nothing was saved", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["todos", 20], applyDelete(data, todoId("a")));
    restoreTodoLists(queryClient, undefined);
    expect(queryClient.getQueryData(["todos", 20])).toEqual(applyDelete(data, todoId("a")));
    restoreTodoLists(queryClient, { previous: [[["todos", 20], data]] });
    expect(queryClient.getQueryData(["todos", 20])).toEqual(data);
  });
});
