"use client";

import type { DirectorPlan } from "@repo/contracts/api";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { CircleAlert, Clock, Film } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { thumbnailUrl } from "@/modules/shorts";
import { INDEX_STEPS, indexStep, shotRhythm } from "../lib/library";
import { timecode } from "../lib/track";

/** The shots as a strip along the picture's foot, each as wide as its share of the short. */
function Rhythm({ plan }: { plan: NonNullable<DirectorPlan["plan"]> }) {
  return (
    <span aria-hidden className="absolute inset-x-3 bottom-3 flex h-1 gap-0.5">
      {shotRhythm(plan.shots).map((shot, index) => (
        <span
          // Shots have no id of their own; their order is what the strip draws.
          key={index}
          className={cn(
            "rounded-full",
            shot.kind === "video" ? "bg-studio-foreground" : "bg-studio-foreground/55",
          )}
          style={{ flex: shot.share }}
        />
      ))}
    </span>
  );
}

/** What's over the picture while the short is being indexed, or once it failed. */
function Status({ plan }: { plan: DirectorPlan }) {
  const t = useTranslations("library");
  const step = indexStep(plan.status, plan.stage);
  if (step === "failed") {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-studio/80 p-3 text-center text-sm font-medium">
        <CircleAlert className="size-5 text-studio-error" aria-hidden />
        {t("card.failed")}
      </span>
    );
  }
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-studio/60 p-3">
      <GeminiShimmer className="absolute inset-0 rounded-none bg-transparent" />
      <span className="relative rounded-full bg-studio/80 px-3 py-1 text-center text-xs font-medium backdrop-blur">
        {t(`stage.${INDEX_STEPS[step] ?? "queued"}`)}
      </span>
    </span>
  );
}

/**
 * A template in the library: the short's picture in portrait with its shot rhythm along
 * the foot, whether it's a starter or a member's own, its title, shots and length. While
 * it's being indexed (or after it failed) the picture says so instead.
 */
export function TemplateCard({ plan }: { plan: DirectorPlan }) {
  const t = useTranslations("library");
  const ready = plan.status === "ready" && plan.plan;
  return (
    <Link
      href={`/director/${plan.videoId}`}
      className="group flex flex-col gap-2 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-studio-foreground focus-visible:ring-offset-4 focus-visible:ring-offset-studio"
    >
      <span className="relative block aspect-9/16 overflow-hidden rounded-2xl bg-studio-foreground/5">
        {/* YouTube's own picture, already sized: nothing for Next's optimizer to do. */}
        <Image
          src={thumbnailUrl(plan.videoId)}
          alt=""
          fill
          unoptimized
          sizes="(max-width: 640px) 50vw, 240px"
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-studio/90 to-transparent"
        />
        <span
          className={cn(
            "absolute top-2.5 left-2.5 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold backdrop-blur",
            plan.source === "seed"
              ? "bg-studio-foreground text-studio"
              : "bg-studio/70 text-studio-foreground ring-1 ring-studio-foreground/30",
          )}
        >
          {t(`card.${plan.source}`)}
        </span>
        {ready ? <Rhythm plan={ready} /> : <Status plan={plan} />}
      </span>
      <span className="line-clamp-2 text-sm leading-snug font-semibold">
        {ready ? ready.title : t("card.pending")}
      </span>
      {ready ? (
        <span className="-mt-1 flex items-center gap-3 text-xs text-studio-foreground/70">
          <span className="flex items-center gap-1">
            <Film className="size-3.5" aria-hidden />
            {t("card.shots", { count: ready.shots.length })}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            {timecode(ready.durationSeconds)}
          </span>
        </span>
      ) : null}
    </Link>
  );
}
