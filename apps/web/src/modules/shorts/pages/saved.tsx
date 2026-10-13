"use client";

import { useApiErrorMessage } from "@repo/client";
import { useSavedShortsQuery } from "@repo/client/api/shorts/saved";
import type { ShortReactionKind } from "@repo/contracts/api";
import { Skeleton } from "@repo/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { useTranslations } from "next-intl";
import { BottomNav } from "../components/bottom-nav";
import { DirectorGate } from "../components/director-gate";
import { ShortCard } from "../components/short-card";
import { TopBar } from "../components/top-bar";

function Saved({ kind }: { kind: ShortReactionKind }) {
  const t = useTranslations("shorts.saved");
  const errorMessage = useApiErrorMessage();
  const saved = useSavedShortsQuery(kind);
  if (saved.isPending) {
    return <Skeleton className="mx-4 aspect-9/16 w-1/2 rounded-xl bg-studio-foreground/10" />;
  }
  if (saved.isError) {
    return (
      <p role="alert" className="px-4 text-sm text-studio-error">
        {errorMessage(saved.error)}
      </p>
    );
  }
  if (saved.data.length === 0) {
    return <p className="px-4 text-sm text-studio-foreground/60">{t("empty")}</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 sm:grid-cols-3">
      {saved.data.map((short) => (
        <li key={short.videoId}>
          <ShortCard short={short} />
        </li>
      ))}
    </ul>
  );
}

/** "You": the shorts the member liked and saved. */
export function SavedPage() {
  const t = useTranslations("shorts.saved");
  return (
    <DirectorGate>
      <div className="mx-auto max-w-3xl pb-24">
        <TopBar />
        <Tabs defaultValue="save" className="gap-4">
          <TabsList className="mx-4">
            <TabsTrigger value="save">{t("saved")}</TabsTrigger>
            <TabsTrigger value="like">{t("liked")}</TabsTrigger>
          </TabsList>
          <TabsContent value="save">
            <Saved kind="save" />
          </TabsContent>
          <TabsContent value="like">
            <Saved kind="like" />
          </TabsContent>
        </Tabs>
      </div>
      <BottomNav />
    </DirectorGate>
  );
}
