/** Sends one delivery again; the log refetches to show the new attempt. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRedeliverWebhookMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.webhooks.redeliver.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: api.webhooks.listDeliveries.key() }),
    }),
  );
}
