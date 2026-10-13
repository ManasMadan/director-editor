"use client";

import { useApiErrorMessage } from "@repo/client";
import { useShortCommentsQuery } from "@repo/client/api/shorts/comments";
import { buttonVariants } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Skeleton } from "@repo/ui/components/skeleton";
import { ThumbsUp } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { shortUrl } from "../lib/embed";

function CommentsBody({ videoId, open }: { videoId: string; open: boolean }) {
  const t = useTranslations("shorts");
  const format = useFormatter();
  const errorMessage = useApiErrorMessage();
  const comments = useShortCommentsQuery(videoId, open);
  if (comments.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (comments.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(comments.error)}
      </p>
    );
  }
  if (comments.data.disabled || comments.data.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(comments.data.disabled ? "comments.disabled" : "comments.empty")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {comments.data.items.map((comment) => (
        <li key={comment.id} className="flex flex-col gap-1">
          <p className="text-xs font-medium">
            {comment.author}{" "}
            <span className="font-normal text-muted-foreground">
              · {format.relativeTime(comment.publishedAt)}
            </span>
          </p>
          <p className="text-sm whitespace-pre-line">{comment.text}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <ThumbsUp className="size-3" aria-hidden />
            {t("count", { count: comment.likeCount })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** A short's top comments from YouTube; commenting happens on YouTube itself. */
export function CommentsDialog({
  videoId,
  open,
  onOpenChange,
}: {
  videoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("shorts");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("comments.title")}</DialogTitle>
        </DialogHeader>
        <CommentsBody videoId={videoId} open={open} />
        <DialogFooter>
          <a
            href={shortUrl(videoId)}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            {t("comments.onYouTube")}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
