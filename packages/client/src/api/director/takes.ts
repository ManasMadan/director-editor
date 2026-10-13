/** The member's takes for a short, followed while Director reviews them. */
import { SECOND_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { takeInProgress } from "./latest";

export function useDirectorTakesQuery(videoId: string, enabled = true) {
  const { api } = useApi();
  return useQuery(
    api.director.takes.queryOptions({
      input: { videoId },
      enabled,
      refetchInterval: (query) => (query.state.data?.some(takeInProgress) ? 3 * SECOND_MS : false),
    }),
  );
}
