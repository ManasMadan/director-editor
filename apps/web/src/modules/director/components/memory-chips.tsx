"use client";

import type { MemoryNote } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { GLASS } from "./shoot-parts";

/**
 * What Director remembers from the conversation ("Inside", "One angle"), as chips above
 * the text box. Tapping × on one forgets it, and Director is told.
 */
export function MemoryChips({
  notes,
  onForget,
}: {
  notes: readonly MemoryNote[];
  onForget: (note: MemoryNote) => void;
}) {
  const t = useTranslations("director.shoot.memory");
  if (notes.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t("label")} className="flex flex-wrap gap-1.5">
      {notes.map((note) => (
        <li
          key={note.note}
          className={cn(
            "live-motion flex animate-[live-rise_300ms_ease-out_both] items-center rounded-full py-0.5 pr-0.5 pl-3 text-sm font-semibold",
            GLASS,
          )}
        >
          <span>{note.note}</span>
          <button
            type="button"
            onClick={() => onForget(note)}
            aria-label={t("forget", { note: note.note })}
            title={t("forget", { note: note.note })}
            className="ml-0.5 flex size-11 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <X className="size-4" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
