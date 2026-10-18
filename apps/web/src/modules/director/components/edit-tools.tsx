"use client";

import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { type CaptionStyle, captionStyles } from "../lib/captions";

/** The editor's two settings, each opened from the transport. */
export type Tool = "captions" | "sound";

/** How the captions look: big words with the one said lit, YouTube's boxed CC, or none. */
export function StylePicker({
  value,
  onChange,
}: {
  value: CaptionStyle;
  onChange: (style: CaptionStyle) => void;
}) {
  const t = useTranslations("director.editor.style");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-xs text-studio-foreground/60">{t("label")}</legend>
      <div className="flex gap-2">
        {captionStyles.map((style) => (
          <button
            key={style}
            type="button"
            aria-pressed={value === style}
            onClick={() => onChange(style)}
            className={cn(
              "flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              value === style
                ? "bg-studio-foreground text-studio"
                : "bg-studio-foreground/10 text-studio-foreground",
            )}
          >
            {t(style)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Whether the takes' own sound goes into the video (only when the member spoke). */
export function SoundPanel({
  voice,
  on,
  onChange,
}: {
  voice: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const t = useTranslations("director");
  if (!voice) {
    return <p className="text-sm text-studio-foreground/70">{t("review.silent")}</p>;
  }
  return (
    <label className="flex items-center justify-between gap-3 text-sm font-medium">
      {t("editor.soundOn")}
      <input
        type="checkbox"
        role="switch"
        aria-checked={on}
        checked={on}
        onChange={(event) => onChange(event.target.checked)}
        className="size-5 accent-record"
      />
    </label>
  );
}
