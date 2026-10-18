/**
 * The pictures the finished video places, one per slot: the image or clip the member
 * chose in the asset picker, else the slot's default (drawn after indexing), else the
 * plan's own default image. Fetched as blobs when the video is made, as the takes are,
 * so the canvas stays CORS-clean and can be recorded.
 */
import type { AssetSlot, ServedShotPlan } from "@repo/contracts/api";
import type { Visual } from "./compose";

/** What a slot shows: its link and whether it's a clip (a Veo clip, a stock video). */
export interface SlotMedia {
  url: string;
  video: boolean;
}

/** The link each slot's picture is read from, by slot id. */
export function slotMedia(
  plan: ServedShotPlan,
  slots: readonly AssetSlot[],
): Map<string, SlotMedia> {
  const media = new Map<string, SlotMedia>();
  for (const asset of plan.assets) {
    if (asset.image?.status === "ready" && asset.image.url) {
      media.set(asset.id, { url: asset.image.url, video: false });
    }
  }
  for (const slot of slots) {
    const chosen = slot.images.find((image) => image.id === slot.chosenId);
    if (chosen?.status === "ready" && chosen.url) {
      media.set(slot.assetId, { url: chosen.url, video: chosen.media === "video" });
    } else if (slot.defaultImage?.status === "ready" && slot.defaultImage.url) {
      media.set(slot.assetId, { url: slot.defaultImage.url, video: false });
    }
  }
  return media;
}

async function videoOf(blob: Blob): Promise<Visual> {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error("a clip couldn't be read"));
  });
  return { kind: "video", video };
}

/**
 * Each slot's picture, ready to draw. One that can't be read is left out: its moment
 * shows the member's own picture instead (lib/compose.ts), rather than failing the save.
 */
export async function loadVisuals(media: ReadonlyMap<string, SlotMedia>): Promise<Map<string, Visual>> {
  const loaded = await Promise.all(
    [...media].map(async ([slotId, { url, video }]): Promise<[string, Visual] | null> => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return null;
        }
        const blob = await response.blob();
        const visual: Visual = video
          ? await videoOf(blob)
          : { kind: "image", image: await createImageBitmap(blob) };
        return [slotId, visual];
      } catch (error) {
        console.warn("a slot's picture couldn't be read", slotId, error);
        return null;
      }
    }),
  );
  return new Map(loaded.filter((entry) => entry !== null));
}

/** Lets go of the pictures once the video is made. */
export function releaseVisuals(visuals: ReadonlyMap<string, Visual>) {
  for (const visual of visuals.values()) {
    if (visual.kind === "image") {
      visual.image.close();
    } else {
      visual.video.pause();
      URL.revokeObjectURL(visual.video.src);
    }
  }
}
