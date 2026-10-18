/** Recording paused (a tap, Space, saying "pause", the tab hidden): nothing records until a touch resumes. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function usePauseRecordingMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.pause.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.key() }),
    }),
  );
}
