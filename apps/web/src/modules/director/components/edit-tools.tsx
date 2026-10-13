"use client";

import { cn } from "@repo/ui/lib/utils";
import { AudioLines, Captions, Clapperboard, Type } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { type CaptionStyle, captionStyles } from "../lib/captions";
import type { EditLine } from "../lib/edit";

export type Tool = "captions" | "text" | "sound";

function ToolButton({
  icon,
  label,
  pressed,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      className={cn(
        "flex min-w-16 flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
        pressed ? "text-studio-foreground" : "text-studio-foreground/70",
      )}
    >
      <span
        className={cn(
          "flex size-9 items-center justify-center rounded-full",
          pressed && "bg-studio-foreground/15",
        )}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

/** The editor's tools along the bottom: caption style, caption text, sound, and a retake. */
export function EditTools({
  tool,
  onTool,
  onRetake,
}: {
  tool: Tool | null;
  onTool: (tool: Tool | null) => void;
  onRetake: (() => void) | null;
}) {
  const t = useTranslations("director.editor.tools");
  const toggle = (next: Tool) => onTool(tool === next ? null : next);
  return (
    <nav
      aria-label={t("label")}
      className="flex justify-around border-t border-studio-foreground/10 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <ToolButton
        icon={<Captions className="size-6" aria-hidden />}
        label={t("captions")}
        pressed={tool === "captions"}
        onClick={() => toggle("captions")}
      />
      <ToolButton
        icon={<Type className="size-6" aria-hidden />}
        label={t("text")}
        pressed={tool === "text"}
        onClick={() => toggle("text")}
      />
      <ToolButton
        icon={<AudioLines className="size-6" aria-hidden />}
        label={t("sound")}
        pressed={tool === "sound"}
        onClick={() => toggle("sound")}
      />
      <ToolButton
        icon={<Clapperboard className="size-6" aria-hidden />}
        label={t("retake")}
        onClick={() => onRetake?.()}
        disabled={!onRetake}
      />
    </nav>
  );
}

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

/** Rewrites one caption's words; kept when the member is done (and undoable after). */
export function TextEditor({
  line,
  onSave,
}: {
  line: EditLine | null;
  onSave: (line: EditLine, text: string) => void;
}) {
  const t = useTranslations("director.editor");
  const [draft, setDraft] = useState(line?.text ?? "");
  if (!line) {
    return <p className="text-sm text-studio-foreground/70">{t("textHint")}</p>;
  }
  const save = () => {
    const text = draft.trim();
    if (text && text !== line.text) {
      onSave(line, text);
    }
  };
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="sr-only" htmlFor="caption-text">
        {t("textLabel")}
      </label>
      <input
        id="caption-text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        maxLength={160}
        className="min-w-0 flex-1 rounded-full bg-studio-foreground/10 px-4 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-studio-foreground/60"
      />
      <button
        type="submit"
        className="rounded-full bg-studio-foreground px-4 py-2 text-sm font-semibold text-studio"
      >
        {t("done")}
      </button>
    </form>
  );
}

/** Whether the takes' own sound goes into the short (only when the member spoke). */
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
