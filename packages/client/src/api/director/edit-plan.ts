/** Saves the member's own changes to the shots of a template they described. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useEditPlanMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.director.editPlan.mutationOptions({
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
