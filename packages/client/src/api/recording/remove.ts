/** "Delete this session": its raw footage and the takes cut from it, now. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRemoveRecordingMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.recording.remove.mutationOptions({
      // Its takes go with it: the shots and takes change too.
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: api.recording.key() }),
          queryClient.invalidateQueries({ queryKey: api.director.key() }),
        ]),
    }),
  );
}
