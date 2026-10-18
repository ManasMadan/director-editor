/**
 * A short's asset slots with the member's own images (the asset picker). Drawn images
 * land in the background: the `director.changed` realtime nudge refetches the slots, and
 * a slow poll covers a missed one while any image is still being made.
 */
import type { DirectorAssets } from "@repo/contracts/api";
import { SECOND_MS } from "@repo/contracts/time";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "../../client";
import { useApi } from "../../provider";
import { fileReady } from "../files/ready";
import { uploadFile } from "../files/upload";

/** Whether any image of the slots is still being drawn. */
function assetsInProgress(assets: DirectorAssets | undefined): boolean {
  return Boolean(
    assets?.slots.some(
      (slot) =>
        slot.defaultImage?.status === "making" ||
        slot.images.some((image) => image.status === "making"),
    ),
  );
}

export function useAssetSlotsQuery(videoId: string) {
  const { api } = useApi();
  return useQuery(
    api.assets.list.queryOptions({
      input: { videoId },
      retry: false,
      refetchInterval: (query) => (assetsInProgress(query.state.data) ? 5 * SECOND_MS : false),
    }),
  );
}

/** Reads a short's slots again, after one of them changed. */
export function refreshSlots(
  queryClient: QueryClient,
  api: ReturnType<typeof useApi>["api"],
  videoId: string,
) {
  return queryClient.invalidateQueries({
    queryKey: api.assets.list.queryKey({ input: { videoId } }),
  });
}

/** A ready upload of the member's picture, for a slot or as a drawing's reference. */
export async function uploadPicture(client: ApiClient, file: File) {
  const uploaded = await uploadFile(client, "director-asset-image", file);
  return fileReady(client, uploaded);
}
