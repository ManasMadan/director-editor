/** Picks the image a slot uses in the member's video (null: its default). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { refreshSlots } from "./slots";

export function useChooseAssetMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.assets.choose.key(),
    mutationFn: (input: { videoId: string; assetId: string; imageId: string | null }) =>
      client.assets.choose(input),
    onSuccess: (_ok, { videoId }) => refreshSlots(queryClient, api, videoId),
  });
}
