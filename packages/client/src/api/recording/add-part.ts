/** A new run of the recorder: the first, or one after a camera flip or a comeback. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAddRecordingPartMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.addPart.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.recording.key() }),
    }),
  );
}
