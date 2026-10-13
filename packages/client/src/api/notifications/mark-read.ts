/** Marks the given notifications read; the inbox and the badge refetch. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useMarkNotificationsReadMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.notifications.markRead.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.notifications.key() }),
    }),
  );
}
