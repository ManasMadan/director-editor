/** Puts a photo of the member's in a slot: uploaded, checked by the worker, then added. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { refreshSlots, uploadPicture } from "./slots";

export function useUploadAssetMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.assets.addUpload.key(),
    mutationFn: async (input: { videoId: string; assetId: string; file: File }) => {
      const ready = await uploadPicture(client, input.file);
      return client.assets.addUpload({
        videoId: input.videoId,
        assetId: input.assetId,
        fileId: ready.id,
      });
    },
    onSuccess: (_image, { videoId }) => refreshSlots(queryClient, api, videoId),
  });
}
