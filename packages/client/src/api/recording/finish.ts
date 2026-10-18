/** Done: the session records nothing more (slices still queued upload after it). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useFinishRecordingMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.finish.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.key() }),
    }),
  );
}
