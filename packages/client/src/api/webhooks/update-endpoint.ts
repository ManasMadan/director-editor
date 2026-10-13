/** Changes an endpoint's URL, description, events, or turns it on or off. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useUpdateWebhookEndpointMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.webhooks.updateEndpoint.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: api.webhooks.listEndpoints.key() }),
    }),
  );
}
