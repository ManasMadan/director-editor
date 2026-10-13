/** Marks every notification read; the inbox and the badge refetch. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useMarkAllNotificationsReadMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.notifications.markAllRead.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.notifications.key() }),
    }),
  );
}
