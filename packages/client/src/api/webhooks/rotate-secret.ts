/** Returns the new signing secret; the old one keeps signing for an overlap period. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRotateWebhookSecretMutation() {
  const { api } = useApi();
  return useMutation(api.webhooks.rotateSecret.mutationOptions());
}
