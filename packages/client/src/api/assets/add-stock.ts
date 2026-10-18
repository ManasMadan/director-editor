/** Puts a stock photo in a slot: the API copies it into storage, with its credit. */
import type { StockProviderName } from "@repo/contracts/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { refreshSlots } from "./slots";

export function useAddStockAssetMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.assets.addStock.key(),
    mutationFn: (input: {
      videoId: string;
      assetId: string;
      provider: StockProviderName;
      photoId: string;
    }) => client.assets.addStock(input),
    onSuccess: (_image, { videoId }) => refreshSlots(queryClient, api, videoId),
  });
}
