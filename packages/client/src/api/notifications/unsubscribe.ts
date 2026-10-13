/** From an email's unsubscribe link (works signed out). */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useUnsubscribeMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.unsubscribe.mutationOptions());
}
