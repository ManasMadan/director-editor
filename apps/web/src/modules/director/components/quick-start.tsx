"use client";

import type { DirectorPlan } from "@repo/contracts/api";
import { Star } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { thumbnailUrl } from "@/modules/shorts";

/**
 * The library's "Quick start": the one starter anyone can shoot right away, alone and
 * indoors (QUICK_START_VIDEO_ID), above the rest, so whoever has a few minutes, a judge on
 * the demo most of all, needn't weigh six cards first. It opens the shoot itself, on the
 * first shot with the member speaking: the start card there says what happens next, and
 * the template page would only be one more screen and one more tap.
 */
export function QuickStart({ plan }: { plan: DirectorPlan }) {
  const t = useTranslations("library.quickStart");
  return (
    <Link
      href={`/director/${plan.videoId}/shoot`}
      className="group flex items-center gap-4 rounded-2xl bg-studio-foreground/8 p-3 ring-1 ring-studio-foreground/15 outline-none transition-colors hover:bg-studio-foreground/12 focus-visible:ring-2 focus-visible:ring-studio-foreground motion-reduce:transition-none"
    >
      <span className="relative aspect-9/16 w-16 shrink-0 overflow-hidden rounded-xl bg-studio-foreground/5">
        {/* YouTube's own picture, already sized: nothing for Next's optimizer to do. */}
        <Image
          src={thumbnailUrl(plan.videoId)}
          alt=""
          fill
          unoptimized
          sizes="4rem"
          className="object-cover"
        />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-aurora-1">
          <Star aria-hidden className="size-3.5 fill-current" />
          {t("label")}
        </span>
        <span className="truncate font-semibold">{plan.plan?.title}</span>
        <span className="text-sm text-studio-foreground/70 text-pretty">{t("body")}</span>
      </span>
    </Link>
  );
}
