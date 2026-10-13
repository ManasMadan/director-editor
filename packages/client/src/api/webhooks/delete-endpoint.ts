/** Deletes an endpoint; nothing more is sent to it. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useDeleteWebhookEndpointMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.webhooks.deleteEndpoint.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: api.webhooks.listEndpoints.key() }),
    }),
  );
}
