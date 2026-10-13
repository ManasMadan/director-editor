"use client";

import type { Shot } from "@repo/contracts/api";
import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "@repo/ui/lib/utils";
import { Check, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { useObjectUrl } from "../hooks/use-object-url";
import { webVtt } from "../lib/captions";
import type { Cut } from "../lib/cut";
import { GLASS } from "./live-hud";

/** The take's best stretch, played over and over, with its sound. */
function CutLoop({
  take,
  cut,
  label,
  script,
  lang,
}: {
  take: Blob;
  cut: Cut;
  label: string;
  script: Shot["script"];
  lang: string;
}) {
  const url = useObjectUrl(take);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(script)], { type: "text/vtt" }), [script]),
  );
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    const toStart = () => {
      element.currentTime = cut.startSeconds;
    };
    const loop = () => {
      if (element.currentTime >= cut.endSeconds || element.currentTime < cut.startSeconds - 0.1) {
        toStart();
      }
    };
    element.addEventListener("loadedmetadata", toStart);
    element.addEventListener("timeupdate", loop);
    element.addEventListener("ended", toStart);
    // Autoplay with sound can be refused; the loop then plays silently rather than not at all.
    element.play().catch(() => {
      element.muted = true;
      void element.play().catch(() => undefined);
    });
    return () => {
      element.removeEventListener("loadedmetadata", toStart);
      element.removeEventListener("timeupdate", loop);
      element.removeEventListener("ended", toStart);
    };
  }, [cut]);
  return (
    <video
      ref={video}
      src={url ?? undefined}
      aria-label={label}
      autoPlay
      playsInline
      className="absolute inset-0 size-full bg-studio object-cover"
    >
      <track kind="captions" src={captions ?? undefined} srcLang={lang} label={label} default />
    </video>
  );
}

function PhotoTake({ take, label }: { take: Blob; label: string }) {
  const url = useObjectUrl(take);
  return url ? (
    // A blob: URL, which Next's image component can't load.
    <picture>
      <img src={url} alt={label} className="absolute inset-0 size-full object-cover" />
    </picture>
  ) : null;
}

/** The score as a hand-drawn star sticker. */
function ScoreStar({ score, label }: { score: number; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="live-motion relative size-20 rotate-6 animate-[live-count_520ms_cubic-bezier(.2,.9,.3,1.3)_both]"
    >
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        className="absolute inset-0 size-full drop-shadow-[0_4px_0_var(--studio)]"
      >
        <path
          d="M50 4 L62 36 L96 37 L69 58 L79 92 L50 72 L21 92 L31 58 L4 37 L38 36 Z"
          strokeLinejoin="round"
          strokeWidth="5"
          className="fill-doodle-pop stroke-studio"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center pt-2 text-xl font-black text-studio tabular-nums">
        {score}
      </span>
    </div>
  );
}

/**
 * The Director's Cut: over the take's best moment, on loop, Director's score and its one
 * piece of praise and one thing to try, then the choice: go again, or keep it and move on.
 */
export function DirectorsCut({
  take,
  cut,
  script,
  sending,
  error,
  onAgain,
  onKeep,
}: {
  take: Blob;
  cut: Cut;
  script: Shot["script"];
  sending: boolean;
  error: string | null;
  onAgain: () => void;
  onKeep: () => void;
}) {
  const t = useTranslations("director.live.cut");
  const locale = useLocale();
  const photo = take.type.startsWith("image/");
  return (
    <div className="absolute inset-0">
      {photo ? (
        <PhotoTake take={take} label={t("title")} />
      ) : (
        <CutLoop take={take} cut={cut} label={t("looping")} script={script} lang={locale} />
      )}
      <div className="absolute inset-0 bg-linear-to-b from-studio/50 via-transparent to-studio/85" />
      <div className="absolute inset-x-4 top-4 flex items-start justify-between">
        <p className="-rotate-3 rounded-xl bg-doodle-paper px-3 py-1 font-[family-name:var(--font-hand)] text-xl text-studio shadow-lg">
          {t("title")}
        </p>
        <ScoreStar score={cut.score} label={t("score", { score: cut.score })} />
      </div>
      <div className="absolute inset-x-3 bottom-3 flex flex-col gap-3">
        <div
          aria-live="polite"
          className={cn(
            "live-motion animate-[live-rise_420ms_ease-out_both] rounded-3xl p-4",
            GLASS,
          )}
        >
          <p className="text-xl leading-tight font-bold text-balance">
            {t(`praise.${cut.praise}`)}
          </p>
          <p className="mt-1 text-[15px] leading-snug text-studio-foreground/80 text-balance">
            {cut.tip ? t(`tip.${cut.tip}`) : t("ship")}
          </p>
          <p className="mt-2 text-xs text-studio-foreground/55">{t("later")}</p>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-studio-error">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onAgain}
            disabled={sending}
            className={cn(
              "flex h-13 flex-1 items-center justify-center gap-2 rounded-full font-semibold transition-transform active:scale-95 disabled:opacity-50",
              GLASS,
            )}
          >
            <RotateCcw className="size-5" aria-hidden />
            {t("again")}
          </button>
          <button
            type="button"
            onClick={onKeep}
            disabled={sending}
            className="flex h-13 flex-[1.4] items-center justify-center gap-2 rounded-full bg-studio-foreground font-semibold text-studio shadow-xl transition-transform active:scale-95 disabled:opacity-70"
          >
            {sending ? <Spinner /> : <Check className="size-5" aria-hidden />}
            {t("keep")}
          </button>
        </div>
      </div>
    </div>
  );
}
