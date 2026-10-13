/**
 * The organization's todos, newest first, loaded page by page.
 *
 *   const todos = useTodoListInfiniteQuery();
 *   todos.data?.pages.flatMap((page) => page.items)
 *   todos.fetchNextPage()   // when todos.hasNextPage
 */

import type { TodoPage } from "@repo/contracts/api";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

const TODO_PAGE_SIZE = 20;

export type TodoListData = InfiniteData<TodoPage, string | undefined>;

export function useTodoListInfiniteQuery(limit = TODO_PAGE_SIZE) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.todo.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
}
