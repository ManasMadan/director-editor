/** One YouTube short's details (title, channel, counts). */

import { MINUTE_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useShortQuery(videoId: string, enabled = true) {
  const { api } = useApi();
  return useQuery(
    api.shorts.get.queryOptions({ input: { videoId }, enabled, staleTime: 5 * MINUTE_MS }),
  );
}
