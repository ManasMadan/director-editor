"use client";

import { errorCode, useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useDirectorShotsQuery } from "@repo/client/api/director/shots";
import type { DirectorPlan, ServedShotPlan, Shot, ShotPlan } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { MINUTE_MS } from "@repo/contracts/time";
import { Button, buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import {
  ArrowLeft,
  CircleAlert,
  Clapperboard,
  Clock,
  Film,
  Mic,
  Music,
  Pause,
  Play,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DirectorGate, type EmbedOptions, sendCommand, YouTubeEmbed } from "@/modules/shorts";
import { CreatedHero } from "../components/created-hero";
import { IndexProgress } from "../components/index-progress";
import { type MediaLinks, ShotList, Storyboard, useMediaLink } from "../components/shot-list";
import { WhatYouNeed } from "../components/what-you-need";
import { type AudioMode, defaultAudio, offersVoice } from "../lib/audio";
import { indexStep, nextShot } from "../lib/library";
import { timecode } from "../lib/track";

function BackLink({ className }: { className?: string }) {
  const t = useTranslations("director.template");
  return (
    <Link
      href="/library"
      aria-label={t("backToLibrary")}
      className={cn(
        "flex size-11 items-center justify-center rounded-full hover:bg-studio-foreground/10",
        className,
      )}
    >
      <ArrowLeft className="size-5" aria-hidden />
    </Link>
  );
}

function Header() {
  const t = useTranslations("director");
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 bg-studio/95 px-4 py-3 backdrop-blur">
      <BackLink />
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
      <div className="flex flex-wrap gap-2">
        {(["voice", "original"] as const).map((mode) => (
          <label
            key={mode}
            className={cn(
              "flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors has-focus-visible:ring-2 has-focus-visible:ring-studio-foreground/60",
              value === mode
                ? "bg-studio-foreground text-studio"
                : "bg-studio-foreground/10 text-studio-foreground hover:bg-studio-foreground/15",
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

/**
 * How the takes get their sound: the member's pick when the original's audio is there to
 * film along to, or the microphone (said plainly) when it couldn't be fetched.
 */
function Sound({
  plan,
  value,
  onChange,
}: {
  plan: DirectorPlan & { plan: ShotPlan };
  value: AudioMode;
  onChange: (mode: AudioMode) => void;
}) {
  const t = useTranslations("director.template");
  if (plan.audio.status === "failed") {
    return (
      <p className="flex items-start gap-2 rounded-2xl bg-studio-foreground/5 p-3 text-sm">
        <Mic className="mt-0.5 size-4 shrink-0 text-guide-warn" aria-hidden />
        {t("audioFailed")}
      </p>
    );
  }
  return <AudioChoice plan={plan.plan} value={value} onChange={onChange} />;
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

/**
 * The template's bar: back to the library, the short's title and the sound. A solid row
 * above the player, not over it: YouTube draws its own title across the top of the
 * video (at the start and when paused), which a floating bar would cover.
 */
function TemplateBar({
  title,
  muted,
  onToggleSound,
}: {
  title: string;
  muted: boolean;
  onToggleSound: () => void;
}) {
  const t = useTranslations("director.template");
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 bg-studio px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
      <BackLink />
      <h1 className="line-clamp-2 min-w-0 flex-1 text-base font-semibold">{title}</h1>
      <button
        type="button"
        onClick={onToggleSound}
        aria-label={muted ? t("unmute") : t("mute")}
        className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        {muted ? (
          <VolumeX className="size-5" aria-hidden />
        ) : (
          <Volume2 className="size-5" aria-hidden />
        )}
      </button>
    </header>
  );
}

/** The original short, big, with what it takes to make it right under it. */
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
  const frame = useRef<HTMLIFrameElement>(null);
  const [muted, setMuted] = useState(true);
  const shot = watching === null ? undefined : plan.shots[watching];
  const toggleSound = () => {
    sendCommand(frame.current, muted ? "unMute" : "mute");
    setMuted(!muted);
  };
  return (
    <>
      <TemplateBar title={plan.title} muted={muted} onToggleSound={toggleSound} />
      <section className="flex justify-center bg-black">
        <YouTubeEmbed
          // A new part to play is a new player: it starts muted, as autoplay must.
          key={watching ?? "all"}
          ref={frame}
          videoId={videoId}
          title={plan.title}
          options={heroOptions(shot, true)}
          // It takes no taps: the strip, the shot cards and the sound button drive it.
          focusable={false}
          className="pointer-events-none aspect-9/16 h-[min(68dvh,calc(100vw*16/9))]"
        />
      </section>
      {/* Under the player, not over its foot: YouTube draws the short's own title, channel
          and Share button there, and the two read as one jumble. */}
      <div className="flex flex-col gap-2 px-4 pt-3">
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
        {shot && watching !== null ? (
          <p className="flex items-center gap-3 text-sm">
            <span className="font-semibold text-record">
              {t("template.playing", { index: watching + 1, title: shot.title })}
            </span>
            <button
              type="button"
              onClick={onWatchAll}
              className="min-h-11 underline underline-offset-4"
            >
              {t("template.watchAll")}
            </button>
          </p>
        ) : null}
      </div>
    </>
  );
}

/** Back up to the player, smoothly unless the member asked for less motion. */
function scrollToPlayer() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/**
 * Music on a loop from `url`, played and paused by the member. An Audio of its own
 * rather than an <audio> element, which would want a captions track: music has no words.
 * Nothing loads until it's played, and leaving stops it. A failed link that a fresher one
 * replaces goes on playing from it, as the member asked.
 */
function useLoop(url: string | undefined, onFailed: () => boolean) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  // The member asked for it to play: a fresher link that takes over a failed one plays on.
  const wanted = useRef(false);
  const failed = useRef(onFailed);
  useLayoutEffect(() => {
    failed.current = onFailed;
  });
  useEffect(() => {
    if (!url) {
      return;
    }
    const element = new Audio();
    element.preload = "none";
    element.loop = true;
    element.src = url;
    const listening = new AbortController();
    const { signal } = listening;
    element.addEventListener("play", () => setPlaying(true), { signal });
    element.addEventListener("pause", () => setPlaying(false), { signal });
    element.addEventListener(
      "error",
      () => {
        setPlaying(false);
        // No fresher link to take over: the player is left out, and asked for nothing.
        if (!failed.current()) {
          wanted.current = false;
        }
      },
      { signal },
    );
    audio.current = element;
    if (wanted.current) {
      element.play().catch(() => undefined);
    }
    return () => {
      listening.abort();
      element.pause();
      // Its pause listener is gone by now: the button mustn't go on saying it plays.
      setPlaying(false);
    };
  }, [url]);
  const toggle = () => {
    if (audio.current?.paused) {
      wanted.current = true;
      // A link that fails says so through the element's error, handled there.
      audio.current.play().catch(() => undefined);
    } else {
      wanted.current = false;
      audio.current?.pause();
    }
  };
  return { playing, toggle };
}

/**
 * A seed's music, made with Lyria, on a player of its own; a track that won't play is
 * left out rather than shown broken.
 */
function Soundtrack({ url, media }: { url: string | undefined; media: MediaLinks }) {
  const t = useTranslations("director.template");
  const track = useMediaLink(url, media);
  const { playing, toggle } = useLoop(track.url, track.failed);
  if (!track.url) {
    return null;
  }
  return (
    <div className="flex items-center gap-3 rounded-full bg-studio-foreground/5 py-1.5 pr-4 pl-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={t("playSoundtrack")}
        aria-pressed={playing}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-studio-foreground text-studio transition-transform active:scale-95"
      >
        {playing ? (
          <Pause className="size-4 fill-current" aria-hidden />
        ) : (
          <Play className="size-4 translate-x-px fill-current" aria-hidden />
        )}
      </button>
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
        <Music className="size-4 shrink-0 text-studio-foreground/60" aria-hidden />
        {t("soundtrack")}
      </p>
    </div>
  );
}

/**
 * A seed's media links, from the plan as last read. They last an hour (a page left open
 * outlives them): once one fails, the plan is read again, at most once a minute, so links
 * that keep failing are left out instead of asked for over and over.
 */
function useMediaLinks(read: number, refetch: () => void): MediaLinks {
  const last = useRef(Number.NEGATIVE_INFINITY);
  const refresh = () => {
    if (Date.now() - last.current > MINUTE_MS) {
      last.current = Date.now();
      refetch();
    }
  };
  return { read, refresh };
}

function Ready({
  plan,
  media,
}: {
  plan: DirectorPlan & { plan: ServedShotPlan };
  media: MediaLinks;
}) {
  const t = useTranslations("director");
  const shots = plan.plan.shots;
  const taken = useDirectorShotsQuery(plan.videoId);
  const [chosen, setChosen] = useState<AudioMode>(() => defaultAudio(plan.plan));
  // Without the original's audio there's nothing to film along to: the mic it is.
  const audio = plan.audio.status === "failed" ? "voice" : chosen;
  const [watching, setWatching] = useState<number | null>(null);
  const videos = shots.filter((shot) => shot.kind === "video").length;
  const next = nextShot(taken.data);
  const watch = (index: number) => {
    setWatching(index);
    scrollToPlayer();
  };
  return (
    // On a laptop, and a phone held sideways, the short sits beside what it takes rather
    // than above it in a phone-wide column.
    <div className="lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-8 short-landscape:grid short-landscape:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] short-landscape:items-start">
      <div className="lg:sticky lg:top-0 short-landscape:sticky short-landscape:top-0">
        {plan.source === "created" ? (
          <CreatedHero plan={plan.plan} videoId={plan.videoId} />
        ) : (
          <Hero
            plan={plan.plan}
            videoId={plan.videoId}
            watching={watching}
            onWatchAll={() => setWatching(null)}
          />
        )}
      </div>
      <div>
        {/* First after the short in reading order, wherever it's drawn: the page's one
            action is a Tab or two away, not after every shot card. */}
        <ShootLink
          videoId={plan.videoId}
          shot={next.index}
          audio={audio}
          label={next.started ? t("template.continue") : t("template.use")}
        />
        <Details>
          <p className="text-sm text-studio-foreground/70">{plan.plan.summary}</p>
          <WhatYouNeed videoId={plan.videoId} plan={plan.plan} />
          <Soundtrack url={plan.plan.musicUrl} media={media} />
          <section className="flex flex-col gap-2">
            <p className="font-semibold">
              {t("needs", { shots: shots.length, videos, photos: shots.length - videos })}
            </p>
            <Storyboard shots={shots} watching={watching} onWatch={watch} />
          </section>
          {/* A template the member described has no original sound to film along to. */}
          {plan.source === "created" ? null : (
            <Sound plan={plan} value={chosen} onChange={setChosen} />
          )}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-studio-foreground/80">{t("inOrder")}</h2>
            <ShotList
              shots={shots}
              takes={taken.data}
              watching={watching}
              onWatch={watch}
              media={media}
            />
          </section>
        </Details>
      </div>
    </div>
  );
}

/** What the template takes, under the short (beside it on a wide screen). */
function Details({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 px-4 pt-2 pb-36 lg:pb-12 short-landscape:pb-12">
      {children}
    </div>
  );
}

/**
 * The page's action: on a phone, fixed at the foot of the screen; beside the short on a
 * wide screen (or a phone held sideways), in the column's flow at its top.
 */
function ShootLink({
  videoId,
  shot,
  audio,
  label,
}: {
  videoId: string;
  shot: number;
  audio: AudioMode;
  label: string;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 bg-linear-to-t from-studio via-studio/95 to-transparent px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:static lg:bg-none lg:pt-4 lg:pb-2 short-landscape:static short-landscape:bg-none short-landscape:pt-3 short-landscape:pb-1">
      <Link
        href={`/director/${videoId}/shoot?shot=${shot}&audio=${audio}`}
        className="mx-auto flex w-full max-w-lg items-center justify-center gap-2.5 rounded-full bg-record py-4 text-lg font-bold text-record-foreground shadow-xl transition-[transform,background-color] hover:bg-record/90 active:scale-[0.98] short-landscape:py-3"
      >
        <span className="size-3.5 rounded-full bg-record-foreground" aria-hidden />
        {label}
      </Link>
    </div>
  );
}

/** A way back to the library, where a short is indexed (never from here). */
function ToLibrary() {
  const t = useTranslations("director.template");
  return (
    <Link href="/library" className={buttonVariants({ variant: "secondary" })}>
      {t("toLibrary")}
    </Link>
  );
}

/** Indexing failed: why, and that it didn't use up the member's own short. */
function Failed({ plan }: { plan: DirectorPlan }) {
  const t = useTranslations("director.template");
  const errorMessage = useApiErrorMessage();
  return (
    <div className="flex flex-col items-center gap-4 p-8 text-center">
      <CircleAlert className="size-8 text-studio-error" aria-hidden />
      <p role="alert" className="font-medium text-studio-error">
        {errorMessage({ code: plan.error ?? "DIRECTOR_ANALYSIS_FAILED" })}
      </p>
      <p className="max-w-sm text-sm text-studio-foreground/70">{t("failedHelp")}</p>
      <ToLibrary />
    </div>
  );
}

/**
 * Before the plan is ready: Gemini at work, why it failed, or why it can't be read.
 * Indexing counts as the member's one short of their own, so it only ever starts from
 * the library's "Bring your own Short", where they ask for it; nothing here retries it.
 */
function NotReady({
  plan,
  error,
  onRetry,
}: {
  plan: DirectorPlan | undefined;
  error: unknown;
  onRetry: () => void;
}) {
  const common = useTranslations("common");
  const t = useTranslations("director");
  const errorMessage = useApiErrorMessage();
  if (error) {
    const missing = errorCode(error) === "DIRECTOR_PLAN_NOT_FOUND";
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(error)}
        </p>
        {missing ? (
          <ToLibrary />
        ) : (
          <Button variant="secondary" onClick={onRetry}>
            {common("retry")}
          </Button>
        )}
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="flex justify-center p-12">
        <GeminiLoader label={t("starting")} size="lg" />
      </div>
    );
  }
  const step = indexStep(plan.status, plan.stage);
  return step === "failed" ? (
    <Failed plan={plan} />
  ) : (
    <IndexProgress step={step} since={plan.updatedAt} className="p-10" />
  );
}

function Plan({ videoId }: { videoId: string }) {
  const plan = useDirectorPlanQuery(videoId);
  const current = plan.data;
  const media = useMediaLinks(plan.dataUpdatedAt, () => void plan.refetch());
  if (current?.status === "ready" && current.plan) {
    return <Ready plan={{ ...current, plan: current.plan }} media={media} />;
  }
  return (
    <>
      <Header />
      <NotReady plan={current} error={plan.error} onRetry={() => void plan.refetch()} />
    </>
  );
}

/**
 * A link whose id can't be a Short's (mistyped, or cut short when it was shared): said in
 * plain words, with the way back, rather than the form error the API's check would give
 * and a "Try again" that could never work.
 */
function NotAShort() {
  const t = useTranslations("director.template");
  return (
    <>
      <Header />
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <p role="alert" className="text-sm text-studio-foreground/80">
          {t("notAShort")}
        </p>
        <ToLibrary />
      </div>
    </>
  );
}

/** A template's page: the original, its storyboard, how each shot is filmed, and the button to start. */
export function DirectorPage({ videoId }: { videoId: string }) {
  return (
    <DirectorGate>
      <div className="mx-auto max-w-lg lg:max-w-5xl short-landscape:max-w-none">
        {videoIdSchema.safeParse(videoId).success ? <Plan videoId={videoId} /> : <NotAShort />}
      </div>
    </DirectorGate>
  );
}
