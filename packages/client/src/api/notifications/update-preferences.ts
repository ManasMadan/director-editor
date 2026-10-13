/** Saves notification choices; the answer replaces the preferences query's data. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useUpdateNotificationPreferencesMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.notifications.updatePreferences.mutationOptions({
      onSuccess: (preferences) =>
        queryClient.setQueryData(api.notifications.preferences.queryKey(), preferences),
    }),
  );
}
