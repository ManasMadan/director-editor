/** Creates a todo and puts it at the top of the list without a refetch. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import type { TodoListData } from "./list";
import { applyCreate } from "./optimistic";

export function useTodoCreateMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const listKey = api.todo.list.key();
  return useMutation(
    api.todo.create.mutationOptions({
      onSuccess: (todo) => {
        queryClient.setQueriesData<TodoListData>({ queryKey: listKey }, (data) =>
          applyCreate(data, todo),
        );
      },
    }),
  );
}
