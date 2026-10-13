/** Asks Director to work out a short; the plan query follows it from there. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRequestDirectorPlanMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.director.requestPlan.mutationOptions({
      onSuccess: (plan) =>
        queryClient.setQueryData(
          api.director.plan.queryKey({ input: { videoId: plan.videoId } }),
          plan,
        ),
    }),
  );
}
