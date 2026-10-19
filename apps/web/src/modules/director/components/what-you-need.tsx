"use client";

import type { ServedShotPlan } from "@repo/contracts/api";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { Clock, ImageIcon, Mic, Scissors, User } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { needsOf } from "../lib/needs";
import { AssetPicker } from "./asset-picker";

type Asset = ServedShotPlan["assets"][number];

// The pieces Director draws a picture for; footage and sound come later (stock, Veo,
// Lyria), so their slots have no picker yet.
const PICKABLE = new Set<Asset["kind"]>(["image", "cutout", "text-card", "background", "end-card"]);

function AssetRow({ asset, onOpen }: { asset: Asset; onOpen: (() => void) | null }) {
  const t = useTranslations("director.whatYouNeed");
  const image = asset.image;
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/10">
        {image?.status === "ready" && image.url ? (
          <img src={image.url} alt="" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-5 text-studio-foreground/60" aria-hidden />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{asset.title}</span>
        {asset.personalisable ? (
          <span className="text-xs text-studio-foreground/70">{t("yourTopic")}</span>
        ) : null}
        {image?.status === "making" ? (
          <GeminiShimmer className="text-xs">{t("drawing")}</GeminiShimmer>
        ) : null}
      </div>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("changeAsset", { title: asset.title })}
          className="min-h-11 rounded-full px-3 text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          {t("change")}
        </button>
      ) : null}
    </li>
  );
}

/**
 * "What you'll need" on a template's page: who's on camera, about how long it takes,
 * what Director makes for you (each one opens the asset picker), and the editing the
 * editor applies, all from the plan.
 */
export function WhatYouNeed({ videoId, plan }: { videoId: string; plan: ServedShotPlan }) {
  const t = useTranslations("director.whatYouNeed");
  const format = useFormatter();
  const needs = needsOf(plan);
  const [picking, setPicking] = useState<Asset | null>(null);
  const editing = needs.editing.map((key) => t(`editing.${key}`));
  return (
    <section className="flex flex-col gap-4" aria-labelledby="what-you-need">
      <h2 id="what-you-need" className="font-semibold">
        {t("title")}
      </h2>
      <ul className="flex flex-col gap-2 text-sm">
        <li className="flex items-center gap-2">
          {needs.presence === "voice-only" ? (
            <Mic className="size-4" aria-hidden />
          ) : (
            <User className="size-4" aria-hidden />
          )}
          {t(`presence.${needs.presence}`)}
        </li>
        <li className="flex items-center gap-2">
          <Clock className="size-4" aria-hidden />
          {t("minutes", { minutes: needs.minutes })}
        </li>
      </ul>
      {needs.makes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-studio-foreground/80">{t("makes")}</h3>
          <ul className="flex flex-col gap-3 text-sm">
            {needs.makes.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                onOpen={PICKABLE.has(asset.kind) ? () => setPicking(asset) : null}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {editing.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-studio-foreground/80">
            <Scissors className="size-4" aria-hidden />
            {t("editingTitle")}
          </h3>
          <p className="text-sm">{format.list(editing, { type: "conjunction" })}</p>
        </div>
      ) : null}
      {picking ? (
        <AssetPicker
          videoId={videoId}
          plan={plan}
          asset={picking}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </section>
  );
}
