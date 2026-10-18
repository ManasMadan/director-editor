/**
 * The workspace's library: its templates (seeded and members' own shorts) and whether the
 * caller has used their one index. While a short in it is being indexed the library
 * changes on its own: the `director.changed` realtime nudge refetches it, and a slow poll
 * covers a missed one.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { planInProgress } from "./progress";

export function useDirectorLibraryQuery() {
  const { api } = useApi();
  return useQuery(
    api.director.library.queryOptions({
      refetchInterval: (query) =>
        query.state.data?.templates.some(planInProgress) ? 3 * SECOND_MS : false,
    }),
  );
}
