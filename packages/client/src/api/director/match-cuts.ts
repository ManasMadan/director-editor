/**
 * Each match cut of an edit lined up by Director (the anchor kept on the same spot across
 * the cut). An answer depends only on the two takes, the cut points and the anchor, so it
 * is kept for the session: picking the same takes again doesn't ask again. A failure
 * isn't retried: the cut plays as a plain cut, and the editor says so.
 */
import type { MatchCutAsk } from "@repo/contracts/api";
import { useQueries } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useMatchCutAlignments(asks: readonly MatchCutAsk[]) {
  const { api } = useApi();
  return useQueries({
    queries: asks.map((input) =>
      api.director.alignMatchCut.queryOptions({
        input,
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
      }),
    ),
  });
}
