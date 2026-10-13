/** The signed-in user (profile, language, time zone, active organization). */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useMeQuery(options: { enabled?: boolean } = {}) {
  const { api } = useApi();
  return useQuery(api.user.me.queryOptions({ enabled: options.enabled ?? true }));
}
