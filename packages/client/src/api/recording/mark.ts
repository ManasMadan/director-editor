/** Director's mark: an attempt at a shot starts or ends (the shoot screen sends each one Director's `mark` tool calls). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useMarkAttemptMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.mark.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.key() }),
    }),
  );
}
