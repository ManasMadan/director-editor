/** Keeps the member's version of a template, and the cached copy the next screen reads. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSaveYourVersionMutation(videoId: string) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.yourVersion.save.mutationOptions({
      // One save at a time, in order: a slow one never lands after a newer version.
      scope: { id: `your-version:${videoId}` },
      onSuccess: (version) =>
        queryClient.setQueryData(api.yourVersion.get.queryKey({ input: { videoId } }), version),
    }),
  );
}
