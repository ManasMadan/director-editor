"use client";

import { useReactToShortMutation } from "@repo/client/api/shorts/react";
import { useShortReactionsQuery } from "@repo/client/api/shorts/reactions";
import type { Short } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { Bookmark, Clapperboard, MessageSquareText, Share2, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { shortUrl } from "../lib/embed";
import { CommentsDialog } from "./comments-dialog";

function RailButton({
  label,
  caption,
  pressed,
  onClick,
  children,
}: {
  label: string;
  caption: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="flex flex-col items-center gap-1 text-xs font-medium"
    >
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-full bg-studio-foreground/15 backdrop-blur transition-colors hover:bg-studio-foreground/25",
          pressed && "bg-studio-foreground text-studio",
        )}
      >
        {children}
      </span>
      <span aria-hidden>{caption}</span>
    </button>
  );
}

/** The Shorts player's right-hand buttons: like, comments, share, save, and Director. */
export function ActionRail({ short, active }: { short: Short; active: boolean }) {
  const t = useTranslations("shorts");
  // Only the short on screen asks: the feed doesn't fetch every short's at once.
  const reactions = useShortReactionsQuery(short.videoId, active);
  const react = useReactToShortMutation();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const liked = reactions.data?.liked ?? false;
  const saved = reactions.data?.saved ?? false;

  const share = async () => {
    const url = shortUrl(short.videoId);
    if (typeof navigator.share === "function") {
      await navigator.share({ title: short.title, url }).catch(() => undefined);
      return;
    }
    await navigator.clipboard
      .writeText(url)
      .then(() => toast.success(t("player.copied")))
      .catch(() => undefined);
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <RailButton
        label={t("player.like")}
        caption={
          short.likeCount !== null ? t("count", { count: short.likeCount }) : t("player.like")
        }
        pressed={liked}
        onClick={() => react.mutate({ videoId: short.videoId, kind: "like", on: !liked })}
      >
        <ThumbsUp className="size-6" aria-hidden />
      </RailButton>
      <RailButton
        label={t("player.comments")}
        caption={
          short.commentCount !== null
            ? t("count", { count: short.commentCount })
            : t("player.comments")
        }
        onClick={() => setCommentsOpen(true)}
      >
        <MessageSquareText className="size-6" aria-hidden />
      </RailButton>
      <RailButton
        label={t("player.share")}
        caption={t("player.share")}
        onClick={() => void share()}
      >
        <Share2 className="size-6" aria-hidden />
      </RailButton>
      <RailButton
        label={t("player.save")}
        caption={t("player.save")}
        pressed={saved}
        onClick={() => react.mutate({ videoId: short.videoId, kind: "save", on: !saved })}
      >
        <Bookmark className="size-6" aria-hidden />
      </RailButton>
      <Link
        href={`/director/${short.videoId}`}
        className="flex flex-col items-center gap-1 text-xs font-semibold"
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-record text-record-foreground shadow-lg ring-2 ring-record-foreground/30">
          <Clapperboard className="size-6" aria-hidden />
        </span>
        {t("player.director")}
      </Link>
      <CommentsDialog videoId={short.videoId} open={commentsOpen} onOpenChange={setCommentsOpen} />
    </div>
  );
}
