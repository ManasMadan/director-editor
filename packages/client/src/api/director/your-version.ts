/**
 * The member's version of a template (what Director remembers, the shots it changed,
 * skipped and left as gaps), read once when a screen opens. The screen holds the version
 * it shows from there, and keeps it with `useSaveYourVersionMutation`, so a refetch never
 * puts an older version back on screen mid-shoot.
 */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useYourVersionQuery(videoId: string) {
  const { api } = useApi();
  return useQuery(
    api.yourVersion.get.queryOptions({
      input: { videoId },
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }),
  );
}
