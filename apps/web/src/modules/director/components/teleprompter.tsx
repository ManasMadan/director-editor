"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { activeLine, lineProgress } from "../lib/timeline";

/** Said lines fade out, the one to say now is full, the ones to come wait half-lit. */
function lineOpacity(at: number, current: number) {
  if (at === current) {
    return "opacity-100";
  }
  return current !== -1 && at < current ? "opacity-30" : "opacity-60";
}

/**
 * The shot's lines, scrolling with the take: the line to say now is lit and swept left
 * to right as its time passes, the next ones wait below.
 */
export function Teleprompter({ script, seconds }: { script: Shot["script"]; seconds: number }) {
  const t = useTranslations("director.shoot");
  const index = activeLine(script, seconds);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const current = list.current?.children.item(Math.max(0, index));
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [index]);

  if (script.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={t("prompter")}
      className="max-h-36 overflow-hidden rounded-2xl bg-studio/70 px-4 py-3 backdrop-blur"
    >
      <ol ref={list} className="flex flex-col gap-2">
        {script.map((line, at) => {
          const now = at === index;
          const progress = now ? lineProgress(script, at, seconds) : 0;
          return (
            <li
              key={`${line.startSeconds}-${at}`}
              aria-current={now ? "true" : undefined}
              className={cn(
                "text-lg leading-snug font-semibold transition-opacity",
                lineOpacity(at, index),
              )}
            >
              {now ? (
                <span
                  className="bg-linear-to-r from-guide to-studio-foreground bg-clip-text text-transparent"
                  style={{
                    backgroundSize: "200% 100%",
                    backgroundPosition: `${100 - progress * 100}% 0`,
                  }}
                >
                  {line.text}
                </span>
              ) : (
                line.text
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
