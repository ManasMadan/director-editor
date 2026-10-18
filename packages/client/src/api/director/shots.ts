/**
 * The caller's takes of a ready plan, shot by shot, with the take picked for each and
 * whether it needs a retake; followed while Director reviews a take. The API refuses it
 * before the plan is ready (DIRECTOR_PLAN_NOT_READY), so it waits to be `enabled`.
 */
import { SECOND_MS } from "@repo/contracts/time";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { takeInProgress } from "./latest";

export function useDirectorShotsQuery(videoId: string, enabled = true) {
  const { api } = useApi();
  return useQuery(
    api.director.shots.queryOptions({
      input: { videoId },
      enabled,
      refetchInterval: (query) =>
        query.state.data?.some((shot) => shot.takes.some(takeInProgress)) ? 3 * SECOND_MS : false,
    }),
  );
}
