/** Sends a test event to an endpoint; it shows in the delivery log. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSendWebhookTestMutation() {
  const { api } = useApi();
  return useMutation(api.webhooks.sendTest.mutationOptions());
}
