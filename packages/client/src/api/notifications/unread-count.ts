/** How many notifications are unread: `{ count }`, for the bell's badge. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useUnreadNotificationsCountQuery() {
  const { api } = useApi();
  return useQuery(api.notifications.unreadCount.queryOptions());
}
