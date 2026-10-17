"use client";

import { useApiErrorMessage } from "@repo/client";
import { useIndexShortMutation } from "@repo/client/api/director/index-short";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import type { DirectorPlan, Shot, ShotPlan } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "@repo/ui/lib/utils";
import {
  ArrowLeft,
  Clapperboard,
  Clock,
  Film,
  Mic,
  Music,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { DirectorGate, type EmbedOptions, sendCommand, YouTubeEmbed } from "@/modules/shorts";
import { ShotList, Storyboard } from "../components/shot-list";
import { type AudioMode, defaultAudio, offersVoice } from "../lib/audio";
import { timecode } from "../lib/track";

function Header({ videoId }: { videoId: string }) {
  const t = useTranslations("director");
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 bg-studio/95 px-4 py-3 backdrop-blur">
      <Link
        href={`/shorts/${videoId}`}
        aria-label={t("back")}
        className="flex size-9 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </Link>
      <h1 className="flex items-center gap-2 font-semibold">
        <Clapperboard className="size-5 text-record" aria-hidden />
        {t("title")}
      </h1>
    </header>
  );
}

function AudioChoice({
  plan,
  value,
  onChange,
}: {
  plan: ShotPlan;
  value: AudioMode;
  onChange: (mode: AudioMode) => void;
}) {
  const t = useTranslations("director.audio");
  if (!offersVoice(plan)) {
    return (
      <p className="flex items-center gap-2 text-sm text-studio-foreground/70">
        <Music className="size-4 shrink-0" aria-hidden />
        {plan.audio === "none" ? t("silent") : t("music")}
      </p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm text-studio-foreground/80">{t("question")}</legend>
      <div className="flex gap-2">
        {(["voice", "original"] as const).map((mode) => (
          <label
            key={mode}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors has-focus-visible:ring-2 has-focus-visible:ring-studio-foreground/60",
              value === mode
                ? "bg-studio-foreground text-studio"
                : "bg-studio-foreground/10 text-studio-foreground",
            )}
          >
            <input
              type="radio"
              name="audio"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className="sr-only"
            />
            {mode === "voice" ? (
              <Mic className="size-4" aria-hidden />
            ) : (
              <Music className="size-4" aria-hidden />
            )}
            {t(mode)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** What the hero plays: the whole short on a loop, or one shot's part of it. */
function heroOptions(shot: Shot | undefined, muted: boolean): EmbedOptions {
  return shot
    ? {
        autoplay: true,
        muted,
        startSeconds: shot.sourceStartSeconds,
        endSeconds: shot.sourceEndSeconds,
      }
    : { autoplay: true, muted, loop: true };
}

/** The original short, big, with what it takes to make it over its foot. */
function Hero({
  plan,
  videoId,
  watching,
  onWatchAll,
}: {
  plan: ShotPlan;
  videoId: string;
  watching: number | null;
  onWatchAll: () => void;
}) {
  const t = useTranslations("director");
  const player = useTranslations("shorts.player");
  const frame = useRef<HTMLIFrameElement>(null);
  const [muted, setMuted] = useState(true);
  const shot = watching === null ? undefined : plan.shots[watching];
  const toggleSound = () => {
    sendCommand(frame.current, muted ? "unMute" : "mute");
    setMuted(!muted);
  };
  return (
    <section className="relative flex justify-center bg-black">
      <YouTubeEmbed
        // A new part to play is a new player: it starts muted, as autoplay must.
        key={watching ?? "all"}
        ref={frame}
        videoId={videoId}
        title={plan.title}
        options={heroOptions(shot, true)}
        className="pointer-events-none aspect-9/16 h-[min(72dvh,calc(100vw*16/9))]"
      />
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href={`/shorts/${videoId}`}
          aria-label={t("back")}
          className="flex size-10 items-center justify-center rounded-full bg-studio/60 backdrop-blur"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        <p className="flex items-center gap-1.5 rounded-full bg-studio/60 px-3 py-2 text-sm font-semibold backdrop-blur">
          <Clapperboard className="size-4 text-record" aria-hidden />
          {t("title")}
        </p>
        <button
          type="button"
          onClick={toggleSound}
          aria-label={muted ? player("unmute") : player("mute")}
          className="ml-auto flex size-10 items-center justify-center rounded-full bg-studio/60 backdrop-blur"
        >
          {muted ? (
            <VolumeX className="size-5" aria-hidden />
          ) : (
            <Volume2 className="size-5" aria-hidden />
          )}
        </button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t from-studio via-studio/70 to-transparent p-4 pt-24">
        <p className="flex items-center gap-1.5 self-start rounded-full bg-studio/70 px-3 py-1 text-xs font-semibold">
          <Sparkles className="size-3.5 text-record" aria-hidden />
          {plan.format}
        </p>
        <h2 className="text-xl font-bold">{plan.title}</h2>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
          <span className="flex items-center gap-1.5">
            <Clock className="size-4" aria-hidden />
            {timecode(plan.durationSeconds)}
          </span>
          <span className="flex items-center gap-1.5">
            <Film className="size-4" aria-hidden />
            {t("template.shots", { count: plan.shots.length })}
          </span>
        </p>
        {shot && watching !== null ? (
          <p className="pointer-events-auto flex items-center gap-3 text-sm">
            <span className="font-semibold text-record">
              {t("template.playing", { index: watching + 1, title: shot.title })}
            </span>
            <button type="button" onClick={onWatchAll} className="underline underline-offset-4">
              {t("template.watchAll")}
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Ready({ plan }: { plan: DirectorPlan & { plan: ShotPlan } }) {
  const t = useTranslations("director");
  const router = useRouter();
  const shots = plan.plan.shots;
  const [audio, setAudio] = useState<AudioMode>(() => defaultAudio(plan.plan));
  const [watching, setWatching] = useState<number | null>(null);
  const videos = shots.filter((shot) => shot.kind === "video").length;
  const watch = (index: number) => {
    setWatching(index);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <>
      <Hero
        plan={plan.plan}
        videoId={plan.videoId}
        watching={watching}
        onWatchAll={() => setWatching(null)}
      />
      <div className="flex flex-col gap-6 px-4 pt-2 pb-36">
        <p className="text-sm text-studio-foreground/70">{plan.plan.summary}</p>
        <section className="flex flex-col gap-2">
          <p className="font-semibold">
            {t("needs", { shots: shots.length, videos, photos: shots.length - videos })}
          </p>
          <Storyboard shots={shots} watching={watching} onWatch={watch} />
        </section>
        <AudioChoice plan={plan.plan} value={audio} onChange={setAudio} />
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-studio-foreground/80">{t("inOrder")}</h3>
          <ShotList shots={shots} watching={watching} onWatch={watch} />
        </section>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 bg-linear-to-t from-studio via-studio/95 to-transparent px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => router.push(`/director/${plan.videoId}/shoot?shot=0&audio=${audio}`)}
          className="mx-auto flex w-full max-w-lg items-center justify-center gap-2.5 rounded-full bg-record py-4 text-lg font-bold text-record-foreground shadow-xl transition-transform active:scale-[0.98]"
        >
          <span className="size-3.5 rounded-full bg-record-foreground" aria-hidden />
          {t("template.use")}
        </button>
      </div>
    </>
  );
}

function Plan({ videoId }: { videoId: string }) {
  const plan = useDirectorPlanQuery(videoId);
  // Indexing counts as the member's one short of their own, so it happens only when they
  // ask (the retry below), never just by opening a short.
  const index = useIndexShortMutation();
  const error = index.error ?? plan.error;
  const current = plan.data;
  if (current?.status === "ready" && current.plan) {
    return <Ready plan={{ ...current, plan: current.plan }} />;
  }
  return (
    <>
      <Header videoId={videoId} />
      <Waiting
        error={error}
        plan={current}
        onRetry={() => index.mutate({ url: `https://www.youtube.com/shorts/${videoId}` })}
      />
    </>
  );
}

/** Before the plan is ready: Director at work, or what went wrong and a retry. */
function Waiting({
  error,
  plan,
  onRetry,
}: {
  error: unknown;
  plan: DirectorPlan | undefined;
  onRetry: () => void;
}) {
  const t = useTranslations("director");
  const errorMessage = useApiErrorMessage();
  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(error)}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (plan?.status === "failed") {
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage({ code: plan.error ?? "DIRECTOR_ANALYSIS_FAILED" })}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center" aria-live="polite">
      <Spinner className="size-8" />
      <p className="font-medium">
        {t(plan?.status === "analyzing" ? "progress.analyzing" : "progress.pending")}
      </p>
      <p className="text-sm text-studio-foreground/60">{t("progress.hint")}</p>
    </div>
  );
}

/** Director's page for a short: what it takes to film it, and the button to start. */
export function DirectorPage({ videoId }: { videoId: string }) {
  return (
    <DirectorGate>
      <div className="mx-auto max-w-lg">
        <Plan videoId={videoId} />
      </div>
    </DirectorGate>
  );
}
