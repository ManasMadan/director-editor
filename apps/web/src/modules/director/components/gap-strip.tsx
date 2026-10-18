"use client";

import type { AssetSlot, ServedAsset, ServedShotPlan } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { Diamond } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { GapSlot } from "../lib/scene";
import { timecode } from "../lib/track";
import { AssetPicker } from "./asset-picker";

/** A gap as the asset picker sees it: a B-roll slot, searched and prompted from its description. */
function gapAsset(gap: GapSlot, slot: AssetSlot | undefined): ServedAsset {
  const what = gap.description;
  return {
    id: gap.slotId,
    kind: "broll",
    title: what.slice(0, 80),
    role: what,
    description: what,
    prompt: slot?.prompt ?? what,
    sourceStartSeconds: 0,
    sourceEndSeconds: 0.1,
    defaultSource: "stock",
    personalisable: false,
    ask: null,
    secondScreen: false,
    reference: {
      subject: what,
      composition: "Vertical 9:16",
      style: "Photo-real B-roll",
      palette: "Natural",
      blackAndWhite: false,
      aspectRatio: "9:16",
      text: [],
      brands: [],
      mood: "",
    },
  };
}

const filled = (slot: AssetSlot | undefined) =>
  Boolean(slot?.images.some((image) => image.id === slot.chosenId && image.status === "ready"));

/**
 * The editor's gap tiles (◇): each B-roll moment of the original and each shot the member
 * skipped, at its time, opening the asset picker on its slot. One left empty holds the
 * nearest shot's picture in the saved video, never black.
 */
export function GapStrip({
  videoId,
  plan,
  gaps,
  slots,
  locked,
}: {
  videoId: string;
  plan: ServedShotPlan;
  gaps: readonly GapSlot[];
  slots: readonly AssetSlot[];
  locked: boolean;
}) {
  const t = useTranslations("director.editor.gaps");
  const [picking, setPicking] = useState<GapSlot | null>(null);
  if (gaps.length === 0) {
    return null;
  }
  const slotOf = (gap: GapSlot) => slots.find((slot) => slot.assetId === gap.slotId);
  return (
    <section aria-labelledby="gap-strip-title" className="flex flex-col gap-2 px-4">
      <h2 id="gap-strip-title" className="text-sm font-semibold">
        {t("title")}
      </h2>
      <p className="text-xs text-studio-foreground/60">{t("hint")}</p>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {gaps.map((gap) => {
          const done = filled(slotOf(gap));
          return (
            <li key={gap.slotId} className="shrink-0">
              <button
                type="button"
                disabled={locked}
                onClick={() => setPicking(gap)}
                aria-label={t("fill", { description: gap.description })}
                className={cn(
                  "flex min-h-11 w-40 flex-col items-start gap-1 rounded-xl border border-studio-foreground/15 px-3 py-2 text-left text-xs disabled:opacity-40",
                  done && "border-record",
                )}
              >
                <span className="flex items-center gap-1 font-mono tabular-nums">
                  <Diamond className="size-3" aria-hidden />
                  {timecode(gap.span.start)}
                </span>
                <span className="line-clamp-2">{gap.description}</span>
                {gap.shotIndex === null ? null : (
                  <span className="text-studio-foreground/60">{t("skipped")}</span>
                )}
                <span className="text-studio-foreground/60">{done ? t("filled") : t("empty")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {picking ? (
        <AssetPicker
          videoId={videoId}
          plan={plan}
          asset={gapAsset(picking, slotOf(picking))}
          open
          onOpenChange={(open) => {
            if (!open) {
              setPicking(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}
