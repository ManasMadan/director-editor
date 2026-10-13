/**
 * The signed-in user's in-app notifications, newest first, page by page. Kept fresh by
 * the realtime stream (useLiveUpdates refetches on "notifications.changed").
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useNotificationsInfiniteQuery(limit = 20) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.notifications.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
}
