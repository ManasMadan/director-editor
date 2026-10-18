/**
 * The default images of a plan's assets (drawn by the AI service right after indexing,
 * apps/ai/app/assets.py), as a template's own page serves them: how each is coming along,
 * and a short-lived link to each one that's ready. A key is signed only when it's the one
 * the image may be (the plan's own folder, the asset's own name), so nothing the AI
 * service answers can get anyone a link to another object. A seeded template's images
 * come from the committed seed instead (seed-media.ts).
 */
import type { Asset, ServedAsset } from "@repo/contracts/api";

/** One image as the AI service reports it (DirectorPlanOut.assetImages). */
export interface AssetImageRow {
  assetId: string;
  status: "pending" | "generating" | "ready" | "failed";
  objectKey: string | null;
}

/** One image as served: its status, and the key to sign once it's ready. */
export interface AssetImage {
  assetId: string;
  status: "making" | "ready" | "failed";
  key: string | null;
}

/** A member's plan's images, from what the AI service reports. */
export function planAssetImages(planId: string, rows: readonly AssetImageRow[]): AssetImage[] {
  return rows.map(({ assetId, status, objectKey }): AssetImage => {
    if (status !== "ready") {
      return { assetId, status: status === "failed" ? "failed" : "making", key: null };
    }
    const at = `director-assets/${planId}/${assetId}`;
    // A ready image stored anywhere else is a bug, served as one that failed.
    return objectKey === `${at}.png` || objectKey === `${at}.jpg`
      ? { assetId, status: "ready", key: objectKey }
      : { assetId, status: "failed", key: null };
  });
}

/**
 * `assets` with each one's image in place: its status, and its link (null with uploads
 * off, as the audio's is). An asset with no image (footage, sound, past the limits) is
 * left as it is.
 */
export function withAssetImages(
  assets: readonly Asset[],
  signed: readonly { image: AssetImage; url: string | null }[],
): ServedAsset[] {
  return assets.map((asset) => {
    const found = signed.find(({ image }) => image.assetId === asset.id);
    return found ? { ...asset, image: { status: found.image.status, url: found.url } } : asset;
  });
}
