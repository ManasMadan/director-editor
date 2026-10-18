/** "Start shooting": opens a recording session on a ready plan. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useStartRecordingMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.start.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.sessions.key() }),
    }),
  );
}
