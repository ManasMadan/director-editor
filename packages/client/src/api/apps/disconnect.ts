/**
 * Disconnects an app: it loses access at once.
 *
 *   const disconnect = useDisconnectAppMutation();
 *   await disconnect.mutateAsync({ id });
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useDisconnectAppMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.apps.disconnect.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: api.apps.list.key() }),
    }),
  );
}
