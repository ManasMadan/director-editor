import { directorSeeds } from "@repo/contracts/director-seeds";
import { buttonVariants } from "@repo/ui/components/button";
import { cn } from "@repo/ui/lib/utils";
import type { Route } from "next";
import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { XRAY } from "../lib/seeds";
import { thumbnailUrl } from "../lib/youtube";
import { OriginalPlayer } from "./original-player";

/*
 * The landing's sections below the hero. Server components: static text and links, plus
 * one client island (the original's player), so the page ships almost no JavaScript.
 */

const heading = "text-2xl font-semibold tracking-tight text-balance sm:text-3xl";

/** The three steps, in the order a member takes them. */
const STEPS = ["index", "shoot", "publish"] as const;

export async function Steps() {
  const t = await getTranslations("home");
  return (
    <section id="how" aria-labelledby="how-title" className="flex scroll-mt-20 flex-col gap-8">
      <h2 id="how-title" className={heading}>
        {t("steps.title")}
      </h2>
      <ol className="grid gap-8 sm:grid-cols-3 sm:gap-6">
        {STEPS.map((step, index) => (
          <li key={step} className="flex flex-col gap-2 border-t pt-4">
            <span aria-hidden className="text-sm font-medium text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <h3 className="text-lg font-semibold">{t(`steps.${step}.title`)}</h3>
            <p className="text-muted-foreground text-pretty">{t(`steps.${step}.body`)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The x-rayed Short itself, playable, beside every shot Gemini found in it. */
export async function Proof() {
  const t = await getTranslations("home");
  const { plan, videoId } = XRAY;
  return (
    <section
      aria-labelledby="proof-title"
      className="grid gap-8 md:grid-cols-[18rem_1fr] md:gap-12"
    >
      <div className="flex flex-col gap-3 md:col-start-2">
        <h2 id="proof-title" className={heading}>
          {t("proof.title")}
        </h2>
        <p className="max-w-prose text-muted-foreground text-pretty">{t("proof.body")}</p>
      </div>
      <div className="mx-auto w-full max-w-72 md:row-span-2 md:row-start-1">
        <OriginalPlayer
          videoId={videoId}
          thumbnail={thumbnailUrl(videoId, "sddefault")}
          playLabel={t("proof.play", { title: plan.title })}
          playerTitle={t("proof.player", { title: plan.title })}
        />
      </div>
      <ol className="flex flex-col divide-y border-y md:col-start-2">
        {plan.shots.map((shot, index) => (
          <li
            key={shot.sourceStartSeconds}
            className="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-1 py-3"
          >
            <span className="row-span-2 text-sm font-medium text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <p className="flex flex-wrap items-baseline justify-between gap-x-4">
              <span className="font-medium">{shot.title}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {t("proof.range", { start: shot.sourceStartSeconds, end: shot.sourceEndSeconds })}
              </span>
            </p>
            <p className="text-sm text-muted-foreground text-pretty">
              {shot.script.map((line) => line.text).join(" ") || t("proof.silent")}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The Google Cloud services Director runs on today, each with what it does here. */
const SERVICES = ["argon", "flash", "live", "storage", "bigquery", "youtube", "signIn"] as const;

export async function Cloud() {
  const t = await getTranslations("home");
  return (
    <section aria-labelledby="cloud-title" className="flex flex-col gap-6">
      <h2 id="cloud-title" className={heading}>
        {t("cloud.title")}
      </h2>
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {SERVICES.map((service) => (
          <div key={service} className="flex flex-col gap-1 border-l-2 border-aurora-1/60 pl-3">
            <dt className="font-medium">{t(`cloud.${service}.name`)}</dt>
            <dd className="text-sm text-muted-foreground">{t(`cloud.${service}.use`)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The 6 seed templates, each opening in Director (or the demo, signed out). */
export async function Templates({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("home");
  return (
    <section aria-labelledby="templates-title" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 id="templates-title" className={heading}>
          {t("templates.title")}
        </h2>
        <p className="max-w-prose text-muted-foreground text-pretty">{t("templates.body")}</p>
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
        {directorSeeds.map(({ videoId, plan }) => {
          const href: Route = signedIn ? `/director/${videoId}` : "/sign-in?demo=1";
          return (
            <li key={videoId}>
              <Link
                href={href}
                className="group flex flex-col gap-2 rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-ring"
              >
                <span className="relative aspect-9/16 overflow-hidden rounded-xl bg-muted">
                  <Image
                    src={thumbnailUrl(videoId, "hqdefault")}
                    alt=""
                    fill
                    unoptimized
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 10rem"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </span>
                <span className="line-clamp-2 text-sm font-medium leading-snug">{plan.title}</span>
                <span className="-mt-1 text-xs text-muted-foreground">
                  {t("templates.meta", {
                    shots: plan.shots.length,
                    seconds: plan.durationSeconds,
                  })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-muted-foreground">{t("templates.credit")}</p>
    </section>
  );
}

export async function Platforms({ cta }: { cta: { href: Route; label: string } }) {
  const t = await getTranslations("home");
  return (
    <section
      aria-labelledby="platforms-title"
      className="flex flex-col items-start gap-6 rounded-3xl bg-live-night p-6 text-studio-foreground sm:p-10"
    >
      <h2 id="platforms-title" className={heading}>
        {t("platforms.title")}
      </h2>
      <p className="max-w-2xl text-lg text-pretty text-studio-foreground/80 sm:text-xl">
        {t("platforms.body")}
      </p>
      {/* Light on the night panel in both themes, where the theme's own buttons would sink. */}
      <Link
        href={cta.href}
        className={cn(
          buttonVariants({ size: "lg" }),
          "bg-studio-foreground text-studio hover:bg-studio-foreground/90",
        )}
      >
        {cta.label}
      </Link>
    </section>
  );
}
