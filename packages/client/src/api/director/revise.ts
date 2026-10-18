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
      // In line with the saves (save-your-version.ts): the API keeps the re-planned
      // version, so a save made while it runs goes after it, and has the last word.
      scope: { id: `your-version:${videoId}` },
      onSuccess: ({ version }) =>
        queryClient.setQueryData(api.yourVersion.get.queryKey({ input: { videoId } }), version),
    }),
  );
}
