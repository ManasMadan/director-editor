/**
 * Marks a todo done or not done. The UI updates instantly (optimistic); if the server
 * rejects the change (e.g. TODO_VERSION_CONFLICT because someone else changed it) the
 * previous state is restored and the list is refetched.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import type { TodoListData } from "./list";
import { applySetCompleted, restoreTodoLists } from "./optimistic";
import { useSettleTodoMutation } from "./settle";

export function useTodoSetCompletedMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const listKey = api.todo.list.key();
  const settle = useSettleTodoMutation();
  return useMutation(
    api.todo.setCompleted.mutationOptions({
      onMutate: async ({ id, completed }) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueriesData<TodoListData>({ queryKey: listKey });
        queryClient.setQueriesData<TodoListData>({ queryKey: listKey }, (data) =>
          applySetCompleted(data, id, completed),
        );
        return { previous };
      },
      onError: (_error, _input, context) => restoreTodoLists(queryClient, context),
      onSettled: settle,
    }),
  );
}
