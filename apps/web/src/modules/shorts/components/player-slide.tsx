"use client";

import type { Short } from "@repo/contracts/api";
import { Volume2, VolumeX } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { sendCommand } from "../lib/embed";
import { ActionRail } from "./action-rail";
import { YouTubeEmbed } from "./youtube-embed";

/**
 * One short in the vertical feed. Only the one on screen loads YouTube's player (the
 * rest show their picture), so the feed stays light and only one plays at a time.
 * It starts muted, as browsers allow autoplay only without sound; the button unmutes.
 */
export function PlayerSlide({
  short,
  onVisible,
}: {
  short: Short;
  onVisible: (videoId: string) => void;
}) {
  const t = useTranslations("shorts");
  const frame = useRef<HTMLIFrameElement>(null);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(true);

  // A ref callback: React runs its cleanup when the section goes or the callback changes.
  const observe = useCallback(
    (element: HTMLElement) => {
      const observer = new IntersectionObserver(
        ([entry]) => {
          const visible = (entry?.intersectionRatio ?? 0) > 0.6;
          setActive(visible);
          // The player comes back muted, as browsers autoplay only without sound.
          if (!visible) {
            setMuted(true);
          }
          if (visible) {
            onVisible(short.videoId);
          }
        },
        { threshold: [0, 0.6, 1] },
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
    [short.videoId, onVisible],
  );

  const toggleSound = () => {
    sendCommand(frame.current, muted ? "unMute" : "mute");
    setMuted(!muted);
  };

  return (
    <section
      ref={observe}
      aria-label={short.title}
      className="relative flex h-dvh snap-start snap-always items-center justify-center"
    >
      <div className="relative aspect-9/16 h-full max-h-dvh max-w-full overflow-hidden bg-studio sm:rounded-2xl">
        {active ? (
          <YouTubeEmbed
            ref={frame}
            videoId={short.videoId}
            title={t("embedTitle", { title: short.title })}
            options={{ autoplay: true, muted: true, loop: true }}
            className="absolute inset-0 size-full"
          />
        ) : (
          <Image
            src={short.thumbnailUrl}
            alt=""
            fill
            unoptimized
            sizes="420px"
            className="object-cover"
          />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-studio/90 to-transparent p-4 pr-20 pb-24">
          <p className="text-sm font-semibold">{t("player.by", { channel: short.channelTitle })}</p>
          <p className="mt-1 line-clamp-2 text-sm">{short.title}</p>
        </div>
        <button
          type="button"
          onClick={toggleSound}
          aria-label={muted ? t("player.unmute") : t("player.mute")}
          className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-studio/60 backdrop-blur"
        >
          {muted ? (
            <VolumeX className="size-5" aria-hidden />
          ) : (
            <Volume2 className="size-5" aria-hidden />
          )}
        </button>
      </div>
      <div className="absolute right-3 bottom-24 sm:static sm:ml-4 sm:self-end sm:pb-24">
        <ActionRail short={short} active={active} />
      </div>
    </section>
  );
}
