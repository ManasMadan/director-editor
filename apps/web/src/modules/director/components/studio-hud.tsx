"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { Volume2, VolumeX, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { Tilt } from "../lib/tilt";
import { BubbleLevel } from "./bubble-level";

/** One segment per shot, as story viewers show them: done, this one, still to come. */
function ShotProgress({ index, count }: { index: number; count: number }) {
  return (
    <div aria-hidden className="flex gap-1">
      {Array.from({ length: count }, (_, at) => (
        <span
          key={`shot-${at + 1}`}
          className={cn(
            "h-1 flex-1 rounded-full",
            at < index && "bg-studio-foreground",
            at === index && "bg-record",
            at > index && "bg-studio-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

/** The camera screen's top: close, which shot this is, the voice toggle and the level. */
export function StudioHud({
  videoId,
  shot,
  index,
  count,
  speak,
  onSpeak,
  tilt,
  onAskTilt,
  recording,
}: {
  videoId: string;
  shot: Shot;
  index: number;
  count: number;
  speak: boolean;
  onSpeak: (on: boolean) => void;
  tilt: Tilt | null;
  onAskTilt: (() => void) | null;
  recording: boolean;
}) {
  const t = useTranslations("director");
  return (
    <div className="flex flex-col gap-3 bg-linear-to-b from-studio/80 to-transparent p-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <ShotProgress index={index} count={count} />
      <div className="flex items-center gap-3">
        <Link
          href={`/director/${videoId}`}
          aria-label={t("back")}
          className="flex size-10 items-center justify-center rounded-full bg-studio/60 backdrop-blur"
        >
          <X className="size-6" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-studio-foreground/70">
            {t("shoot.shotOf", { index: index + 1, count })}
          </p>
          <p className="truncate font-semibold">{shot.title}</p>
        </div>
        {recording ? (
          <p className="flex items-center gap-1.5 rounded-full bg-record px-2.5 py-1 text-xs font-semibold text-record-foreground">
            <span className="size-2 animate-pulse rounded-full bg-record-foreground" />
            {t("shoot.recording")}
          </p>
        ) : null}
        <button
          type="button"
          aria-label={t("shoot.speak")}
          aria-pressed={speak}
          onClick={() => onSpeak(!speak)}
          className={cn(
            "flex size-9 items-center justify-center rounded-full backdrop-blur",
            speak ? "bg-studio-foreground text-studio" : "bg-studio/60",
          )}
        >
          {speak ? (
            <Volume2 className="size-5" aria-hidden />
          ) : (
            <VolumeX className="size-5" aria-hidden />
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <BubbleLevel tilt={tilt} target={shot.phoneAngle} onAsk={onAskTilt} />
        <p className="rounded-full bg-studio/60 px-3 py-1.5 text-xs backdrop-blur">
          {t(`shoot.height.${shot.phoneAngle.height}`)}
        </p>
      </div>
    </div>
  );
}
