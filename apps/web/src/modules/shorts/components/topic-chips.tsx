"use client";

import { type ShortTopic, shortTopics } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";

/** The row of topic chips under YouTube's top bar. */
export function TopicChips({
  value,
  onChange,
}: {
  value: ShortTopic;
  onChange: (topic: ShortTopic) => void;
}) {
  const t = useTranslations("shorts");
  return (
    <fieldset className="m-0 min-w-0 border-0 flex gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none]">
      <legend className="sr-only">{t("topicsLabel")}</legend>
      {shortTopics.map((topic) => (
        <button
          key={topic}
          type="button"
          aria-pressed={topic === value}
          onClick={() => onChange(topic)}
          className={cn(
            "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
            topic === value
              ? "bg-studio-foreground text-studio"
              : "bg-studio-foreground/10 text-studio-foreground hover:bg-studio-foreground/20",
          )}
        >
          {t(`topics.${topic}`)}
        </button>
      ))}
    </fieldset>
  );
}
