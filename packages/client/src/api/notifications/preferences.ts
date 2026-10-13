/** What the user receives: per category and channel, the daily digest, quiet hours. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useNotificationPreferencesQuery() {
  const { api } = useApi();
  return useQuery(api.notifications.preferences.queryOptions());
}
