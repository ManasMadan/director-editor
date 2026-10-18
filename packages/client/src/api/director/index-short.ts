/**
 * Indexes a short from its YouTube link (the member's one of their own, or one already in
 * the library); the plan query follows it from there, and the library shows it.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useIndexShortMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.director.index.mutationOptions({
      onSuccess: async (plan) => {
        queryClient.setQueryData(
          api.director.plan.queryKey({ input: { videoId: plan.videoId } }),
          plan,
        );
        await queryClient.invalidateQueries({ queryKey: api.director.library.key() });
      },
    }),
  );
}
