/**
 * Likes or saves a short, or undoes it. Optimistic: the button changes at once and goes
 * back if the API refuses; the saved lists refetch after.
 */
import type { ShortReactions } from "@repo/contracts/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { reacted } from "./reacted";

export function useReactToShortMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.shorts.react.mutationOptions({
      onMutate: async ({ videoId, kind, on }) => {
        const key = api.shorts.reactions.queryKey({ input: { videoId } });
        await queryClient.cancelQueries({ queryKey: key });
        const before = queryClient.getQueryData<ShortReactions>(key);
        queryClient.setQueryData<ShortReactions>(key, reacted(before, kind, on));
        return { key, before };
      },
      onError: (_error, _input, context) => {
        if (context) {
          queryClient.setQueryData(context.key, context.before);
        }
      },
      onSuccess: (reactions, { videoId }) => {
        queryClient.setQueryData(api.shorts.reactions.queryKey({ input: { videoId } }), reactions);
        return queryClient.invalidateQueries({ queryKey: api.shorts.saved.key() });
      },
    }),
  );
}
