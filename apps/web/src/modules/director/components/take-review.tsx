"use client";

import type { Shot } from "@repo/contracts/api";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Check, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo } from "react";
import { useObjectUrl } from "../hooks/use-object-url";
import { webVtt } from "../lib/captions";
import { GLASS } from "./shoot-parts";

/**
 * The take, played over and over with its sound. The shot's lines are there as captions to
 * turn on; off by default, they'd sit under the buttons and aren't always what was said.
 */
function TakeLoop({ take, label, script }: { take: Blob; label: string; script: Shot["script"] }) {
  const lang = useLocale();
  const url = useObjectUrl(take);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(script)], { type: "text/vtt" }), [script]),
  );
  const start = (element: HTMLVideoElement) => {
    // Autoplay with sound can be refused; the loop then plays silently rather than not at all.
    element.play().catch(() => {
      element.muted = true;
      // Not even silently: the browser says why.
      element.play().catch(reportError);
    });
  };
  return (
    <video
      src={url ?? undefined}
      aria-label={label}
      playsInline
      loop
      onLoadedMetadata={(event) => start(event.currentTarget)}
      className="absolute inset-0 size-full bg-studio object-cover"
    >
      <track kind="captions" src={captions ?? undefined} srcLang={lang} label={label} />
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

/**
 * The take just recorded, on loop, to watch back with Director: then go again, or keep
 * it and move on. Keeping it sends it to Director, who reviews the whole take.
 */
export function TakeReview({
  take,
  script,
  sending,
  error,
  onAgain,
  onKeep,
  captions,
  tell,
}: {
  take: Blob;
  script: Shot["script"];
  sending: boolean;
  error: string | null;
  onAgain: () => void;
  onKeep: () => void;
  /** What Director's saying about it. */
  captions: ReactNode;
  /** The text box, to answer Director without a microphone. */
  tell: ReactNode;
}) {
  const t = useTranslations("director.shoot.review");
  const photo = take.type.startsWith("image/");
  return (
    <div className="absolute inset-0">
      {photo ? (
        <PhotoTake take={take} label={t("photo")} />
      ) : (
        <TakeLoop take={take} label={t("looping")} script={script} />
      )}
      <div className="absolute inset-0 bg-linear-to-b from-studio/40 via-transparent to-studio/85" />
      <p
        className={cn("absolute top-3 left-3 rounded-full px-3 py-1 text-sm font-semibold", GLASS)}
      >
        {t("title")}
      </p>
      <div className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col gap-3">
        {captions}
        {tell}
        {error ? (
          <p
            role="alert"
            className={cn("rounded-2xl px-3.5 py-2.5 text-sm text-studio-error", GLASS)}
          >
            {error}
          </p>
        ) : null}
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
            {sending ? (
              <GeminiLoader as="span" label={t("sending")} size="sm" />
            ) : (
              <Check className="size-5" aria-hidden />
            )}
            {t("keep")}
          </button>
        </div>
      </div>
    </div>
  );
}
