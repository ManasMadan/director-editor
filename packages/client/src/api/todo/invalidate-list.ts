/** Refetch the todo list (e.g. after a change made elsewhere). */
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useInvalidateTodoListQuery() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: api.todo.list.key() });
}
