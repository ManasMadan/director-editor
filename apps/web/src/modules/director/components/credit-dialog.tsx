"use client";

import type { DirectorPlan } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { RefObject } from "react";
import { thumbnailUrl } from "@/modules/shorts";

/**
 * Said when a member asks to index a second short of their own (DIRECTOR_INDEX_LIMIT):
 * their one is used, and here are the starter templates they can shoot instead.
 */
export function CreditDialog({
  open,
  onOpenChange,
  seeds,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seeds: DirectorPlan[];
  /** Where focus goes once it closes: the link field, to paste another link. */
  finalFocus: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations("library.credit");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        finalFocus={finalFocus}
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <span className="flex size-10 items-center justify-center rounded-full bg-linear-to-br from-aurora-1 via-aurora-2 to-aurora-3 text-studio-foreground">
            <Sparkles className="size-5" aria-hidden />
          </span>
          <DialogTitle className="text-lg font-semibold">{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        {seeds.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">{t("seeds")}</p>
            <ul className="grid grid-cols-3 gap-2">
              {seeds.map((seed) => (
                <li key={seed.id}>
                  <Link
                    href={`/director/${seed.videoId}`}
                    className="flex flex-col gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="relative block aspect-9/16 overflow-hidden rounded-lg bg-muted">
                      <Image
                        src={thumbnailUrl(seed.videoId)}
                        alt=""
                        fill
                        unoptimized
                        sizes="120px"
                        className="object-cover"
                      />
                    </span>
                    <span className="line-clamp-2 text-xs font-medium">{seed.plan?.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
