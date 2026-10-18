/**
 * Every cut the member saved, newest first, for My media. Followed while one is being
 * published, so its status moves on without a reload.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useDirectorMediaQuery() {
  const { api } = useApi();
  return useQuery(
    api.director.media.queryOptions({
      refetchInterval: (query) =>
        query.state.data?.some((cut) => cut.publish.status === "uploading") ? 3 * SECOND_MS : false,
    }),
  );
}
