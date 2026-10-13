/** Revokes an API key; it stops working immediately. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRevokeApiKeyMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.apiKeys.revoke.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: api.apiKeys.list.key() }),
    }),
  );
}
