"use client";

import { takeInProgress } from "@repo/client/api/director/latest";
import type { DirectorShot, ServedShotPlan, Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { Camera, CircleCheck, Pause, Play, RotateCcw, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { angleOf } from "../lib/library";

/** A shot as a template's page gets it: a seed's also links its storyboard and preview. */
type ServedShot = ServedShotPlan["shots"][number];

/**
 * Where a seed's media links come from: the plan as last `read` (when, in ms), and how to
 * ask for it again with fresh links once one has failed.
 */
export interface MediaLinks {
  read: number;
  refresh: () => void;
}

/**
 * A link to one of a seed's media, for the element showing it (one card's storyboard or
 * preview, the soundtrack): the first link it was given, for as long as that one works.
 * Once it fails to load, the page reads the plan again for fresh links (`refresh`) and the
 * element is left out meanwhile, so no broken image shows; the plan as read next brings
 * the link tried in its place (the same one, if it was signed again within the second).
 */
export function useMediaLink(url: string | undefined, links: MediaLinks) {
  // Every read of the plan signs every link afresh (on focus, on a nudge), so the link in
  // use is kept: a new one would restart what's playing and download what's shown again.
  const [held, setHeld] = useState(url);
  // When the link in use failed: the plan as read then.
  const [failedAt, setFailedAt] = useState<number>();
  if (failedAt !== undefined && failedAt !== links.read) {
    // Read again since: its fresh link takes over (React's update-while-rendering).
    setHeld(url);
    setFailedAt(undefined);
  }
  return {
    url: failedAt === undefined ? held : undefined,
    failed: () => {
      setFailedAt(links.read);
      links.refresh();
    },
  };
}

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
    // A long short's shots don't all fit a phone's width: the strip scrolls on its own,
    // each shot staying big enough to tap.
    <ol
      aria-label={t("template.storyboard")}
      className="flex h-14 snap-x gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
    >
      {shots.map((shot, index) => {
        const Icon = shot.kind === "video" ? Video : Camera;
        return (
          <li
            key={`${shot.title}-${index}`}
            className="min-w-9 snap-start"
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

/** A portrait frame with the box the member stands in, as the camera's outline draws it. */
function FramingBox({ shot, className }: { shot: Shot; className: string }) {
  const t = useTranslations("director");
  const { subject, shotSize } = shot.framing;
  return (
    <div
      role="img"
      aria-label={t("template.frame", { size: t(`live.size.${shotSize}`) })}
      className={cn(
        "relative aspect-9/16 shrink-0 overflow-hidden rounded-lg bg-studio-foreground/10 ring-1 ring-studio-foreground/20",
        className,
      )}
    >
      <span
        className="absolute rounded-md border-2 border-dashed border-guide bg-guide/15"
        style={{
          left: `${subject.x * 100}%`,
          top: `${subject.y * 100}%`,
          width: `${subject.width * 100}%`,
          height: `${subject.height * 100}%`,
        }}
      />
    </div>
  );
}

/** How the shot is filmed: where, how it's framed, and how to hold the phone. */
function HowTo({ shot }: { shot: Shot }) {
  const t = useTranslations("director");
  const angle = angleOf(shot.phoneAngle);
  const tilt = {
    level: t("template.level"),
    up: t("template.tiltUp", { degrees: angle.degrees }),
    down: t("template.tiltDown", { degrees: angle.degrees }),
  }[angle.tilt];
  return (
    <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-studio-foreground/55">{t("template.scene")}</dt>
      <dd>{shot.scene}</dd>
      <dt className="text-studio-foreground/55">{t("template.framing")}</dt>
      <dd>
        {t(`live.size.${shot.framing.shotSize}`)}
        <span className="block text-studio-foreground/65">{shot.framing.note}</span>
      </dd>
      <dt className="text-studio-foreground/55">{t("template.angle")}</dt>
      <dd className="flex flex-col">
        <span>{t(`shoot.height.${shot.phoneAngle.height}`)}</span>
        <span className="text-studio-foreground/65">{tilt}</span>
        <span className="text-studio-foreground/65">{t(`camera.${shot.camera}`)}</span>
      </dd>
    </dl>
  );
}

/** What the member has filmed of the shot so far, when they have. */
function TakeState({ shot }: { shot: DirectorShot | undefined }) {
  const t = useTranslations("director.template");
  if (!shot || shot.takes.length === 0) {
    return null;
  }
  const picked = shot.takes.find((take) => take.id === shot.pickedTakeId);
  if (picked && picked.score !== null) {
    return shot.needsRetake ? (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-guide-warn">
        <RotateCcw className="size-3.5" aria-hidden />
        {t("needsRetake", { score: picked.score })}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-guide">
        <CircleCheck className="size-3.5" aria-hidden />
        {t("scored", { score: picked.score })}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-studio-foreground/80">
      <CircleCheck className="size-3.5" aria-hidden />
      {shot.takes.some(takeInProgress) ? t("reviewing") : t("filmed")}
    </span>
  );
}

/** The lines the shot's teleprompter shows, when there are any. */
function Script({ shot }: { shot: Shot }) {
  const t = useTranslations("director.template");
  if (shot.script.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-studio-foreground/55">{t("script")}</p>
      {shot.script.map((line) => (
        <blockquote
          key={`${line.startSeconds}-${line.text}`}
          className="border-l-2 border-record pl-3 text-sm italic"
        >
          {line.text}
        </blockquote>
      ))}
    </div>
  );
}

type MediaLink = ReturnType<typeof useMediaLink>;

/**
 * A seed's shot as its storyboard card (drawn by Nano Banana), with the framing sketch in
 * its corner. Tapped, the shot's preview (made with Veo) plays in its place, muted and
 * looping; nothing plays by itself, and the list lets only one play at a time.
 */
function StoryboardCard({
  shot,
  index,
  storyboard,
  preview,
  playing,
  onPlaying,
}: {
  shot: Shot;
  index: number;
  storyboard: { url: string; failed: () => void };
  preview: MediaLink;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
}) {
  const t = useTranslations("director.template");
  const clip = playing ? preview.url : undefined;
  return (
    <figure className="flex w-28 shrink-0 flex-col gap-1.5">
      <div className="relative aspect-9/16 overflow-hidden rounded-xl bg-studio-foreground/10 ring-1 ring-studio-foreground/15">
        {clip ? (
          <video
            src={clip}
            poster={storyboard.url}
            autoPlay
            muted
            loop
            playsInline
            onError={() => {
              onPlaying(false);
              preview.failed();
            }}
            className="size-full object-cover"
          />
        ) : (
          <img
            src={storyboard.url}
            alt={t("storyboardAlt", { title: shot.title, scene: shot.scene })}
            loading="lazy"
            decoding="async"
            onError={storyboard.failed}
            className="size-full object-cover"
          />
        )}
        <FramingBox
          shot={shot}
          className="pointer-events-none absolute top-1.5 right-1.5 w-7 rounded-md bg-studio/50 ring-studio-foreground/40 backdrop-blur-sm"
        />
        {preview.url ? (
          <button
            type="button"
            onClick={() => onPlaying(!playing)}
            aria-label={
              playing
                ? t("pausePreview", { index: index + 1 })
                : t("playPreview", { index: index + 1 })
            }
            className="absolute inset-0 flex items-end p-2 outline-none focus-visible:ring-2 focus-visible:ring-studio-foreground focus-visible:ring-inset"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-studio/70 backdrop-blur-sm">
              {playing ? (
                <Pause className="size-3.5 fill-current" aria-hidden />
              ) : (
                <Play className="size-3.5 translate-x-px fill-current" aria-hidden />
              )}
            </span>
          </button>
        ) : null}
      </div>
      <figcaption className="text-[11px] leading-snug text-studio-foreground/60">
        {clip ? t("previewBy") : t("storyboardBy")}
      </figcaption>
    </figure>
  );
}

/**
 * Where the shot is filmed, at a glance: a seed's storyboard card while its link works,
 * else the framing sketch on its own (a member's own short has no media).
 */
function ShotPicture({
  shot,
  index,
  playing,
  onPlaying,
  media,
}: {
  shot: ServedShot;
  index: number;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  media: MediaLinks;
}) {
  const storyboard = useMediaLink(shot.storyboardUrl, media);
  const preview = useMediaLink(shot.previewUrl, media);
  return storyboard.url ? (
    <StoryboardCard
      shot={shot}
      index={index}
      storyboard={{ url: storyboard.url, failed: storyboard.failed }}
      preview={preview}
      playing={playing}
      onPlaying={onPlaying}
    />
  ) : (
    <FramingBox shot={shot} className="w-16" />
  );
}

/** One shot as a storyboard card. */
function ShotCard({
  shot,
  index,
  taken,
  watching,
  onWatch,
  previewing,
  onPreviewing,
  media,
}: {
  shot: ServedShot;
  index: number;
  taken: DirectorShot | undefined;
  watching: boolean;
  onWatch: () => void;
  previewing: boolean;
  onPreviewing: (playing: boolean) => void;
  media: MediaLinks;
}) {
  const t = useTranslations("director");
  const Icon = shot.kind === "video" ? Video : Camera;
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl bg-studio-foreground/5 p-4",
        watching && "ring-2 ring-record",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-studio-foreground text-sm font-bold text-studio">
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="font-semibold">{shot.title}</h3>
          <p className="text-sm text-studio-foreground/70">{shot.purpose}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-studio-foreground/10 px-2 py-1 text-xs font-medium">
          <Icon className="size-3.5" aria-hidden />
          {t(`kind.${shot.kind}`)}
          <span className="text-studio-foreground/65">
            {t("seconds", { seconds: shot.durationSeconds })}
          </span>
        </span>
      </div>
      <div className="flex gap-4">
        <ShotPicture
          shot={shot}
          index={index}
          playing={previewing}
          onPlaying={onPreviewing}
          media={media}
        />
        <HowTo shot={shot} />
      </div>
      <Script shot={shot} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onWatch}
          aria-label={t("template.watchShot", { index: index + 1, title: shot.title })}
          className="flex items-center gap-1.5 rounded-full bg-studio-foreground/10 px-3 py-1.5 text-xs font-semibold hover:bg-studio-foreground/15"
        >
          <Play className="size-3.5 fill-current" aria-hidden />
          {t("watch")}
        </button>
        <TakeState shot={taken} />
      </div>
    </li>
  );
}

/**
 * The plan's shots in order, as storyboard cards: what each is for, where and how it's
 * framed, how to hold the phone, the lines to say, what's filmed of it, and its part of
 * the original to watch. A seed's cards also show its storyboard, and play its previews
 * one at a time, from the links in `media`.
 */
export function ShotList({
  shots,
  takes,
  watching,
  onWatch,
  media,
}: {
  shots: readonly ServedShot[];
  takes: readonly DirectorShot[] | undefined;
  watching: number | null;
  onWatch: (index: number) => void;
  media: MediaLinks;
}) {
  const [previewing, setPreviewing] = useState<number | null>(null);
  return (
    <ol className="flex flex-col gap-3">
      {shots.map((shot, index) => (
        <ShotCard
          key={`${shot.title}-${index}`}
          shot={shot}
          index={index}
          taken={takes?.find((taken) => taken.index === index)}
          watching={watching === index}
          onWatch={() => onWatch(index)}
          previewing={previewing === index}
          onPreviewing={(playing) => setPreviewing(playing ? index : null)}
          media={media}
        />
      ))}
    </ol>
  );
}
