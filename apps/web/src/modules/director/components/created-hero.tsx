"use client";

import type { ServedShotPlan } from "@repo/contracts/api";
import { buttonVariants } from "@repo/ui/components/button";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { ArrowLeft, Clock, Film, PenLine, Sparkles } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { timecode } from "../lib/track";

// The hero shows the first few cards: enough to see the video's look at a glance.
const HERO_CARDS = 3;

/**
 * A template the member described has no original to play: its hero is its storyboard,
 * the first few shots' cards side by side, with a way back to changing its shots.
 */
export function CreatedHero({ plan, videoId }: { plan: ServedShotPlan; videoId: string }) {
  const t = useTranslations("director");
  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-studio/95 px-4 py-3 backdrop-blur">
        <Link
          href="/library"
          aria-label={t("template.backToLibrary")}
          className="flex size-11 items-center justify-center rounded-full hover:bg-studio-foreground/10"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-semibold">{plan.title}</h1>
      </header>
      <section className="flex flex-col gap-3 px-4 pt-2">
        <ul className="grid grid-cols-3 gap-2">
          {plan.shots.slice(0, HERO_CARDS).map((shot, index) => (
            <li
              // The cards are the plan's first shots, in order.
              key={index}
              className="relative aspect-9/16 overflow-hidden rounded-xl bg-studio-foreground/10"
            >
              {shot.storyboardUrl ? (
                <img
                  src={shot.storyboardUrl}
                  alt={t("template.storyboardAlt", { title: shot.title, scene: shot.scene })}
                  className="size-full object-cover"
                />
              ) : (
                <>
                  <GeminiShimmer className="absolute inset-0 rounded-none bg-transparent" />
                  <span className="sr-only">{t("template.noStoryboard")}</span>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
          <span className="flex items-center gap-1.5 rounded-full bg-studio-foreground/10 px-3 py-1 text-xs font-semibold">
            <Sparkles className="size-3.5 text-record" aria-hidden />
            {plan.format}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="size-4" aria-hidden />
            {timecode(plan.durationSeconds)}
          </span>
          <span className="flex items-center gap-1.5">
            <Film className="size-4" aria-hidden />
            {t("template.shots", { count: plan.shots.length })}
          </span>
        </p>
        <Link
          href={`/create/${videoId}`}
          className={buttonVariants({ variant: "secondary", className: "h-11 self-start" })}
        >
          <PenLine className="size-4" aria-hidden />
          {t("template.changeShots")}
        </Link>
      </section>
    </>
  );
}
