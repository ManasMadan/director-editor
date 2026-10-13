/**
 * onSettled for todo mutations: refetch the list, but only when the last overlapping
 * todo mutation settles. Otherwise an earlier mutation's refetch can land after a later
 * optimistic change and bring back, say, a todo that was just deleted.
 */
import { type Mutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

/**
 * Todo mutations whose onSettled has run. A mutation stays pending until its onSettled
 * is done, so counting pending ones (`isMutating()`) can't tell: two settling in the
 * same tick would each see the other and neither would refetch.
 */
const settled = new WeakSet<Mutation>();

export function useSettleTodoMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const listKey = api.todo.list.key();
  const mutationKey = api.todo.key({ type: "mutation" });
  // What onMutate returned (a new snapshot each time) tells the settling mutation apart.
  return (_data: unknown, _error: unknown, _input: unknown, snapshot: unknown) => {
    const pending = queryClient.getMutationCache().findAll({ mutationKey, status: "pending" });
    for (const mutation of pending) {
      if (mutation.state.context === snapshot) {
        settled.add(mutation);
      }
    }
    return pending.every((mutation) => settled.has(mutation))
      ? queryClient.invalidateQueries({ queryKey: listKey })
      : undefined;
  };
}
