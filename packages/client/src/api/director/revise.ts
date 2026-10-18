/**
 * Director re-plans the member's version from one instruction ("one position, front
 * camera"): Gemini rewrites it, the API keeps it, and the cached copy follows.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useReviseMutation(videoId: string) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.yourVersion.revise.mutationOptions({
      onSuccess: ({ version }) =>
        queryClient.setQueryData(api.yourVersion.get.queryKey({ input: { videoId } }), version),
    }),
  );
}
