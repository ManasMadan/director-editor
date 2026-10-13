/** Whether the member liked or saved a short. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useShortReactionsQuery(videoId: string, enabled = true) {
  const { api } = useApi();
  return useQuery(api.shorts.reactions.queryOptions({ input: { videoId }, enabled }));
}
