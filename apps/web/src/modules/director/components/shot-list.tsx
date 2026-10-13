"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { Camera, Play, Video } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * The shots as a storyboard strip, each as wide as its share of the short: tap one to
 * watch that part of the original above.
 */
export function Storyboard({
  shots,
  watching,
  onWatch,
}: {
  shots: readonly Shot[];
  watching: number | null;
  onWatch: (index: number) => void;
}) {
  const t = useTranslations("director");
  return (
    <ol aria-label={t("template.storyboard")} className="flex h-14 gap-1">
      {shots.map((shot, index) => {
        const Icon = shot.kind === "video" ? Video : Camera;
        return (
          <li
            key={`${shot.title}-${index}`}
            className="min-w-9"
            style={{ flex: shot.durationSeconds }}
          >
            <button
              type="button"
              onClick={() => onWatch(index)}
              aria-pressed={watching === index}
              aria-label={t("template.watchShot", { index: index + 1, title: shot.title })}
              className={cn(
                "flex size-full flex-col items-center justify-center gap-0.5 rounded-lg text-xs font-semibold transition-colors",
                watching === index
                  ? "bg-record text-record-foreground"
                  : "bg-studio-foreground/10 hover:bg-studio-foreground/15",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {index + 1}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The plan's shots in order: what each is, how it's filmed, and its part to watch. */
export function ShotList({
  shots,
  watching,
  onWatch,
}: {
  shots: readonly Shot[];
  watching: number | null;
  onWatch: (index: number) => void;
}) {
  const t = useTranslations("director");
  return (
    <ol className="flex flex-col gap-3">
      {shots.map((shot, index) => {
        const Icon = shot.kind === "video" ? Video : Camera;
        return (
          <li
            key={`${shot.title}-${index}`}
            className={cn(
              "flex items-start gap-3 rounded-2xl bg-studio-foreground/5 p-4",
              watching === index && "ring-2 ring-record",
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-studio-foreground/10 text-sm font-semibold">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-semibold">{shot.title}</p>
              <p className="text-sm text-studio-foreground/70">{shot.purpose}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-studio-foreground/60">
                <span className="flex items-center gap-1">
                  <Icon className="size-3.5" aria-hidden />
                  {t(`kind.${shot.kind}`)}
                </span>
                <span>{t("seconds", { seconds: shot.durationSeconds })}</span>
                <span>{t(`camera.${shot.camera}`)}</span>
                <span>{shot.scene}</span>
              </p>
              <button
                type="button"
                onClick={() => onWatch(index)}
                className="mt-1 flex items-center gap-1.5 self-start rounded-full bg-studio-foreground/10 px-3 py-1.5 text-xs font-semibold hover:bg-studio-foreground/15"
              >
                <Play className="size-3.5 fill-current" aria-hidden />
                {t("watch")}
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
