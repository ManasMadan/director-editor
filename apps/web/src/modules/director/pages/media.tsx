"use client";

import { useApiErrorMessage } from "@repo/client";
import { useDirectorMediaQuery } from "@repo/client/api/director/media";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useDirectorShotsQuery } from "@repo/client/api/director/shots";
import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import type { DirectorCut } from "@repo/contracts/api";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Play } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { DirectorGate } from "@/modules/shorts";
import { PublishButton } from "../components/publish-sheet";
import { useObjectUrl } from "../hooks/use-object-url";
import { webVtt } from "../lib/captions";
import { cutsByTemplate, templateThumbnail } from "../lib/cuts";
import { clipsOf, editLines } from "../lib/edit";
import { pickedTakes } from "../lib/picks";
import { timecode } from "../lib/track";

/** Where the cut's publishing stands on YouTube (publishing itself is its own step). */
function PublishChip({ publish }: { publish: DirectorCut["publish"] }) {
  const t = useTranslations("director.media.publish");
  const styles: Record<DirectorCut["publish"]["status"], string> = {
    none: "bg-studio-foreground/10 text-studio-foreground/70",
    uploading: "bg-studio-foreground/15 text-studio-foreground",
    published: "bg-studio-foreground text-studio",
    failed: "bg-studio-error/20 text-studio-error",
  };
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        styles[publish.status],
      )}
    >
      {publish.status === "uploading" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-aurora-2 motion-safe:animate-pulse" />
      ) : null}
      {publish.status === "published"
        ? t("published", { visibility: publish.visibility ?? "other" })
        : t(publish.status)}
    </span>
  );
}

type Playback = { state: "idle" | "loading" | "failed" } | { state: "playing"; url: string };

/**
 * The cut's captions as a text track, worked out again from its plan and the takes it
 * picked, as the editor burned them in: for screen readers' players. None while they
 * load, or when the template has gone.
 */
function useCutCaptions(cut: DirectorCut) {
  const plan = useDirectorPlanQuery(cut.videoId);
  const ready = plan.data?.status === "ready" ? plan.data.plan : null;
  const shots = useDirectorShotsQuery(cut.videoId, ready !== null);
  const vtt = useMemo(() => {
    if (!ready || !shots.data) {
      return null;
    }
    const clips = clipsOf(ready.shots, pickedTakes(shots.data, cut.picks));
    return new Blob([webVtt(editLines(clips))], { type: "text/vtt" });
  }, [ready, shots.data, cut.picks]);
  return useObjectUrl(vtt);
}

function CutVideo({ cut, url }: { cut: DirectorCut; url: string }) {
  const locale = useLocale();
  const captions = useCutCaptions(cut);
  return (
    // The captions are in the picture; the track is there for screen readers' players.
    <video
      src={url}
      controls
      autoPlay
      playsInline
      aria-label={cut.title}
      className="size-full bg-black object-contain"
    >
      <track kind="captions" src={captions ?? undefined} srcLang={locale} label={cut.title} />
    </video>
  );
}

/** The cut's frame: the template's picture until it's tapped, then the cut itself. */
function CutPlayer({ cut }: { cut: DirectorCut }) {
  const t = useTranslations("director.media");
  const downloadUrl = useFileDownloadUrl();
  const [playback, setPlayback] = useState<Playback>({ state: "idle" });
  if (playback.state === "playing") {
    return <CutVideo cut={cut} url={playback.url} />;
  }
  const play = () => {
    setPlayback({ state: "loading" });
    downloadUrl(cut.fileId).then(
      ({ url }) => setPlayback({ state: "playing", url }),
      () => setPlayback({ state: "failed" }),
    );
  };
  return (
    <button
      type="button"
      onClick={play}
      disabled={playback.state === "loading"}
      aria-label={t("play", { title: cut.title })}
      className="group relative size-full"
    >
      {/* YouTube's own thumbnail: nothing for Next's optimizer to do. */}
      <img
        src={templateThumbnail(cut.videoId)}
        alt=""
        className="absolute inset-0 size-full scale-110 object-cover opacity-60 blur-[2px]"
      />
      <span className="absolute inset-0 bg-linear-to-t from-studio/90 via-studio/20 to-transparent" />
      <span className="absolute inset-0 flex items-center justify-center">
        {playback.state === "loading" ? (
          <GeminiLoader label={t("opening")} />
        ) : (
          <span className="flex size-14 items-center justify-center rounded-full bg-studio-foreground/90 text-studio shadow-xl transition-transform group-hover:scale-105">
            <Play className="ml-0.5 size-6 fill-current" aria-hidden />
          </span>
        )}
      </span>
      <span className="absolute bottom-2 left-2 rounded bg-studio/80 px-1.5 py-0.5 font-mono text-xs tabular-nums">
        {timecode(cut.durationMs / 1000)}
      </span>
      {playback.state === "failed" ? (
        <span role="alert" className="absolute inset-x-2 top-2 text-xs text-studio-error">
          {t("playFailed")}
        </span>
      ) : null}
    </button>
  );
}

function CutCard({ cut }: { cut: DirectorCut }) {
  const format = useFormatter();
  // Where focus goes when the publish sheet closes with nothing left to publish.
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <li className="flex flex-col gap-2">
      <div className="aspect-9/16 overflow-hidden rounded-2xl bg-studio-foreground/5">
        <CutPlayer cut={cut} />
      </div>
      <div className="flex flex-col gap-1 px-0.5">
        <h3 ref={heading} tabIndex={-1} className="truncate text-sm font-medium outline-none">
          {cut.title}
        </h3>
        <p className="text-xs text-studio-foreground/60">
          {format.dateTime(cut.createdAt, { dateStyle: "medium", timeStyle: "short" })}
        </p>
        <PublishChip publish={cut.publish} />
        <div>
          <PublishButton cut={cut} heading={heading} />
        </div>
      </div>
    </li>
  );
}

function Template({ videoId, title, cuts }: ReturnType<typeof cutsByTemplate>[number]) {
  const t = useTranslations("director.media");
  return (
    <section aria-labelledby={`template-${videoId}`} className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        {/* YouTube's own thumbnail: nothing for Next's optimizer to do. */}
        <img
          src={templateThumbnail(videoId)}
          alt=""
          className="aspect-square w-12 shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0">
          <h2 id={`template-${videoId}`} className="truncate text-lg font-semibold">
            {title}
          </h2>
          <p className="text-xs text-studio-foreground/60">{t("count", { count: cuts.length })}</p>
        </div>
      </header>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
        {cuts.map((cut) => (
          <CutCard key={cut.id} cut={cut} />
        ))}
      </ul>
    </section>
  );
}

function Media() {
  const t = useTranslations("director.media");
  const errorMessage = useApiErrorMessage();
  const media = useDirectorMediaQuery();
  if (media.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        role="status"
        aria-label={t("loading")}
      >
        {[0, 1, 2].map((tile) => (
          <GeminiShimmer key={tile} className="aspect-9/16 rounded-2xl bg-studio-foreground/10" />
        ))}
      </div>
    );
  }
  if (media.isError) {
    return (
      <p role="alert" className="text-sm text-studio-error">
        {errorMessage(media.error)}
      </p>
    );
  }
  if (media.data.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-10">
        <p className="text-lg font-semibold">{t("empty")}</p>
        <p className="max-w-sm text-sm text-studio-foreground/70">{t("emptyHint")}</p>
        <Link
          href="/library"
          className="rounded-full bg-record px-5 py-2.5 text-sm font-semibold text-record-foreground"
        >
          {t("pick")}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-10">
      {cutsByTemplate(media.data).map((group) => (
        <Template key={group.videoId} {...group} />
      ))}
    </div>
  );
}

/** My media: every video the member saved, under the Short it was made from. */
export function MediaPage() {
  const t = useTranslations("director.media");
  return (
    <DirectorGate>
      {/* On the studio stage, under the site header (STUDIO_PATHS), like the library. */}
      <div className="flex flex-col gap-6 pt-6 lg:pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <Media />
      </div>
    </DirectorGate>
  );
}
