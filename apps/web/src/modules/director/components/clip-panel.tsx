"use client";

import { useApiErrorMessage } from "@repo/client";
import type { DirectorTake } from "@repo/contracts/api";
import { Spinner } from "@repo/ui/components/spinner";
import { Camera, Video } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { AudioMode } from "../lib/audio";
import type { Clip } from "../lib/edit";

function Review({ take }: { take: DirectorTake }) {
  const t = useTranslations("director.review");
  const errorMessage = useApiErrorMessage();
  if (take.status === "pending" || take.status === "reviewing") {
    return (
      <p className="flex items-center gap-2 text-sm text-studio-foreground/70">
        <Spinner />
        {t("reviewing")}
      </p>
    );
  }
  if (take.status === "failed") {
    return (
      <p className="text-sm text-studio-error">
        {errorMessage({ code: take.error ?? "DIRECTOR_REVIEW_FAILED" })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-sm">{take.feedback}</p>
      {take.bestStartMs !== null && take.bestEndMs !== null ? (
        <p className="text-xs text-studio-foreground/60">
          {t("keeps", { start: take.bestStartMs / 1000, end: take.bestEndMs / 1000 })}
        </p>
      ) : null}
    </div>
  );
}

/** The clip under the playhead (or tapped): its shot, Director's review, and a retake. */
export function ClipPanel({
  videoId,
  clip,
  audio,
}: {
  videoId: string;
  clip: Clip;
  audio: AudioMode;
}) {
  const t = useTranslations("director");
  const Icon = clip.shot.kind === "video" ? Video : Camera;
  const score = clip.take?.score ?? null;
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 shrink-0 text-studio-foreground/60" aria-hidden />
          <span className="truncate">
            {t("editor.clip", { index: clip.index + 1, title: clip.shot.title })}
          </span>
          {score === null ? null : (
            <span className="shrink-0 -rotate-3 rounded-full bg-doodle-pop px-2 py-0.5 text-xs font-bold text-studio shadow">
              {t("review.score", { score })}
            </span>
          )}
        </p>
        {clip.take ? (
          <Review take={clip.take} />
        ) : (
          <p className="text-sm text-studio-foreground/60">{t("review.missing")}</p>
        )}
      </div>
      <Link
        href={`/director/${videoId}/shoot?shot=${clip.index}&audio=${audio}`}
        className="shrink-0 rounded-full bg-studio-foreground/10 px-4 py-2 text-sm font-semibold hover:bg-studio-foreground/15"
      >
        {clip.take ? t("review.retake") : t("review.film")}
      </Link>
    </div>
  );
}
