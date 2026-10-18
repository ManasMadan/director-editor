/**
 * A short's Director plan. While Gemini works it out the plan changes on its own: the
 * `director.changed` realtime nudge refetches it, and a slow poll covers a missed one.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { planInProgress } from "./progress";

export function useDirectorPlanQuery(videoId: string) {
  const { api } = useApi();
  return useQuery(
    api.director.plan.queryOptions({
      input: { videoId },
      // DIRECTOR_PLAN_NOT_FOUND is an answer (nobody asked yet), not a failure to retry.
      retry: false,
      refetchInterval: (query) => (planInProgress(query.state.data) ? 3 * SECOND_MS : false),
    }),
  );
}
