"use client";

import { useApiErrorMessage } from "@repo/client";
import { useShortsFeedInfiniteQuery } from "@repo/client/api/shorts/feed";
import type { ShortTopic } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BottomNav } from "../components/bottom-nav";
import { DirectorGate } from "../components/director-gate";
import { PasteLink } from "../components/paste-link";
import { ShortCard } from "../components/short-card";
import { TopBar } from "../components/top-bar";
import { TopicChips } from "../components/topic-chips";

function Feed({ topic }: { topic: ShortTopic }) {
  const t = useTranslations("shorts");
  const errorMessage = useApiErrorMessage();
  const feed = useShortsFeedInfiniteQuery(topic);
  if (feed.isPending) {
    return (
      <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="aspect-9/16 rounded-xl bg-studio-foreground/10" />
        ))}
      </div>
    );
  }
  if (feed.isError) {
    return (
      <p role="alert" className="px-4 text-sm text-studio-error">
        {errorMessage(feed.error)}
      </p>
    );
  }
  const shorts = feed.data.pages.flatMap((page) => page.items);
  if (shorts.length === 0) {
    return <p className="px-4 text-sm text-studio-foreground/60">{t("empty")}</p>;
  }
  return (
    <>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 sm:grid-cols-3">
        {shorts.map((short) => (
          <li key={short.videoId}>
            <ShortCard short={short} />
          </li>
        ))}
      </ul>
      {feed.hasNextPage ? (
        <div className="flex justify-center p-6">
          <Button
            variant="secondary"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** YouTube's home: topic chips and a grid of shorts, each a template to film. */
export function HomePage() {
  const [topic, setTopic] = useState<ShortTopic>("all");
  return (
    <DirectorGate>
      <div className="mx-auto max-w-3xl pb-24">
        <TopBar />
        <TopicChips value={topic} onChange={setTopic} />
        <PasteLink />
        <Feed topic={topic} />
      </div>
      <BottomNav />
    </DirectorGate>
  );
}
