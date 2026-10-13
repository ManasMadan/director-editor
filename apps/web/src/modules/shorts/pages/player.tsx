"use client";

import { useApiErrorMessage } from "@repo/client";
import { useShortsFeedInfiniteQuery } from "@repo/client/api/shorts/feed";
import { useShortQuery } from "@repo/client/api/shorts/get";
import type { Short } from "@repo/contracts/api";
import { Spinner } from "@repo/ui/components/spinner";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BottomNav } from "../components/bottom-nav";
import { DirectorGate } from "../components/director-gate";
import { PlayerSlide } from "../components/player-slide";

/** The short asked for first (when there is one), then the feed, without repeats. */
function playlist(first: Short | undefined, feed: Short[]): Short[] {
  const seen = new Set<string>();
  return [...(first ? [first] : []), ...feed].filter((short) => {
    if (seen.has(short.videoId)) {
      return false;
    }
    seen.add(short.videoId);
    return true;
  });
}

function Player({ videoId }: { videoId: string | undefined }) {
  const t = useTranslations("shorts");
  const errorMessage = useApiErrorMessage();
  const requested = useShortQuery(videoId ?? "", videoId !== undefined);
  const feed = useShortsFeedInfiniteQuery("all");
  const items = feed.data?.pages.flatMap((page) => page.items);
  const shorts = useMemo(() => playlist(requested.data, items ?? []), [requested.data, items]);
  // Read when a slide comes on screen; kept in a ref so the slides' observers don't
  // restart every time the feed's state changes.
  const latest = useRef({ last: "", more: () => undefined });
  useEffect(() => {
    latest.current = {
      last: shorts.at(-1)?.videoId ?? "",
      more: () => {
        if (feed.hasNextPage && !feed.isFetchingNextPage) {
          void feed.fetchNextPage();
        }
      },
    };
  });

  const onVisible = useCallback((id: string) => {
    // The address follows the short on screen, as on YouTube, without a navigation.
    window.history.replaceState(null, "", `/shorts/${id}`);
    if (id === latest.current.last) {
      latest.current.more();
    }
  }, []);

  const error = requested.error ?? feed.error;
  if (error) {
    return (
      <p role="alert" className="p-8 text-center text-sm text-studio-error">
        {errorMessage(error)}
      </p>
    );
  }
  if (shorts.length === 0) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="h-dvh snap-y snap-mandatory overflow-y-scroll [scrollbar-width:none]">
      <Link
        href="/home"
        aria-label={t("homeTitle")}
        className="fixed top-4 left-4 z-20 flex size-10 items-center justify-center rounded-full bg-studio/60 backdrop-blur"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </Link>
      {shorts.map((short) => (
        <PlayerSlide key={short.videoId} short={short} onVisible={onVisible} />
      ))}
    </div>
  );
}

/** The Shorts player: swipe up for the next short; Director films the one on screen. */
export function ShortsPlayerPage({ videoId }: { videoId?: string }) {
  return (
    <DirectorGate>
      <Player videoId={videoId} />
      <BottomNav />
    </DirectorGate>
  );
}
