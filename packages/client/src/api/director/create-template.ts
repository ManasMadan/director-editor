/**
 * Asks for the template the member described: the library shows it, and its plan query
 * follows it while Gemini writes it, as it does an indexed short.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useCreateTemplateMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.director.create.mutationOptions({
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
