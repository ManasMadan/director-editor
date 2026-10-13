/**
 * Creates an API key for the active workspace. The key itself is in the answer only.
 *
 *   const create = useCreateApiKeyMutation();
 *   const { key } = await create.mutateAsync({ name, scopes, expiresInDays });   // show it once
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useCreateApiKeyMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.apiKeys.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.apiKeys.list.key() }),
    }),
  );
}
