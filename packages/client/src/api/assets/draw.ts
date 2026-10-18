/**
 * Asks Director for an image in a slot: drawn from a prompt (and a photo of the
 * member's, uploaded first), or an edit of another of the slot's images.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { refreshSlots, uploadPicture } from "./slots";

export interface DrawInput {
  videoId: string;
  assetId: string;
  prompt: string;
  /** With `baseId`: what to change in that image. */
  instruction?: string;
  baseId?: string;
  /** A photo of the member's to draw from. */
  reference?: File;
}

export function useDrawAssetMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.assets.draw.key(),
    mutationFn: async ({ reference, ...input }: DrawInput) => {
      const referenceFileId = reference ? (await uploadPicture(client, reference)).id : undefined;
      return client.assets.draw({ ...input, ...(referenceFileId && { referenceFileId }) });
    },
    onSuccess: (_image, { videoId }) => refreshSlots(queryClient, api, videoId),
  });
}
