/** Stock photos for words, once there are some (the last results stay while it looks). */
import { SECOND_MS } from "@repo/contracts/time";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useStockSearchQuery(
  query: string,
  orientation: "portrait" | "landscape" | "square",
) {
  const { api } = useApi();
  const words = query.trim();
  return useQuery(
    api.assets.searchStock.queryOptions({
      input: { query: words, orientation },
      enabled: words.length > 0,
      retry: false,
      placeholderData: keepPreviousData,
      // The API caches the providers' answers a day; a few minutes here saves the calls.
      staleTime: 10 * 60 * SECOND_MS,
    }),
  );
}
