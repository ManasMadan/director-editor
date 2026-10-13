/**
 * Adds a webhook endpoint. Its signing secret is in the answer only.
 *
 *   const create = useCreateWebhookEndpointMutation();
 *   const { secret } = await create.mutateAsync({ url, events });   // show it once
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useCreateWebhookEndpointMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.webhooks.createEndpoint.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: api.webhooks.listEndpoints.key() }),
    }),
  );
}
