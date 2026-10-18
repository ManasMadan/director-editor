"use client";

import type { FrameBox } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { User } from "lucide-react";
import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";
import type { SlotPlacement } from "../lib/slot-preview";

const boxStyle = (box: FrameBox): CSSProperties => ({
  left: `${box.x * 100}%`,
  top: `${box.y * 100}%`,
  width: `${box.width * 100}%`,
  height: `${box.height * 100}%`,
});

const CAPTION_TOP: Record<NonNullable<SlotPlacement["captions"]>, string> = {
  top: "12%",
  middle: "50%",
  bottom: "82%",
  "between-halves": "50%",
};

/** Where the sample caption sits: at the seam of a split, or the template's place. */
function captionTop(captions: NonNullable<SlotPlacement["captions"]>, camera: FrameBox | null) {
  if (captions === "between-halves" && camera) {
    const seam = camera.y === 0 ? camera.height : camera.y;
    return `${seam * 100}%`;
  }
  return CAPTION_TOP[captions];
}

/**
 * "Preview in your video": a 9:16 frame with the candidate placed, fitted and graded as
 * the template's edit list says, beside where the member's camera picture goes (the
 * template's own frame of that moment when there is one) and where the captions sit.
 */
export function SlotPreview({
  placement,
  imageUrl,
  cameraUrl,
}: {
  placement: SlotPlacement;
  imageUrl: string | null;
  cameraUrl: string | undefined;
}) {
  const t = useTranslations("director.picker");
  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="relative aspect-9/16 w-40 overflow-hidden rounded-xl bg-black shadow-lg ring-1 ring-white/10">
        {placement.camera ? (
          <div
            className="absolute flex items-center justify-center bg-neutral-800"
            style={boxStyle(placement.camera)}
          >
            {cameraUrl ? (
              <img src={cameraUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex flex-col items-center gap-1 text-xs text-white/70">
                <User className="size-6" aria-hidden />
                {t("you")}
              </span>
            )}
          </div>
        ) : null}
        <div className="absolute overflow-hidden bg-neutral-900" style={boxStyle(placement.asset)}>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className={cn(
                "size-full",
                placement.fit === "cover" ? "object-cover" : "object-contain",
              )}
              style={placement.filter ? { filter: placement.filter } : undefined}
            />
          ) : null}
        </div>
        {placement.captions ? (
          <span
            className="absolute inset-x-2 -translate-y-1/2 rounded bg-black/80 px-1 py-0.5 text-center text-[0.6rem] font-bold text-white"
            style={{ top: captionTop(placement.captions, placement.camera) }}
          >
            {t("captionSample")}
          </span>
        ) : null}
      </div>
      <figcaption className="text-xs text-muted-foreground">{t("previewNote")}</figcaption>
    </figure>
  );
}
