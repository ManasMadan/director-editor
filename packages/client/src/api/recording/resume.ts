/** Recording resumed: only ever from a touch on the shoot screen, never by voice or by Director. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useResumeRecordingMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.resume.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.key() }),
    }),
  );
}
