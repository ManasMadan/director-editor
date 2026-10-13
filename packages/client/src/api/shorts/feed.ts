/**
 * The Shorts feed on a topic, page by page (real YouTube shorts, read by the API).
 *
 *   const feed = useShortsFeedInfiniteQuery("grwm");
 *   feed.data?.pages.flatMap((page) => page.items)
 *   feed.fetchNextPage()   // when feed.hasNextPage
 */
import type { ShortTopic } from "@repo/contracts/api";
import { MINUTE_MS } from "@repo/contracts/time";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useShortsFeedInfiniteQuery(topic: ShortTopic) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.shorts.feed.infiniteOptions({
      input: (pageToken: string | undefined) => ({ topic, ...(pageToken && { pageToken }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextPageToken ?? undefined,
      // YouTube's quota is small; the API caches too, this saves the round trip.
      staleTime: 5 * MINUTE_MS,
    }),
  );
}
