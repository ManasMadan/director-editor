/** A short's top comments, loaded when the comments sheet opens. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useShortCommentsQuery(videoId: string, enabled: boolean) {
  const { api } = useApi();
  return useQuery(api.shorts.comments.queryOptions({ input: { videoId }, enabled }));
}
