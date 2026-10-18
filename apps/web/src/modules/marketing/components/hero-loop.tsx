"use client";

import { cn } from "@repo/ui/lib/utils";
import { Pause, Play } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * The hero's figure, with a button that pauses its looping conversation and plays it
 * again: anything that moves on its own for more than five seconds needs one (WCAG 2.2.2).
 * Pausing freezes the CSS animations where they are (landing.css, `.hero-paused`). With
 * reduced motion nothing moves, so there's no button. The label comes translated from
 * the server; the button says whether it's pressed, so one label serves both states.
 */
export function HeroLoop({ pauseLabel, children }: { pauseLabel: string; children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const Icon = paused ? Play : Pause;
  return (
    <figure className={cn("flex flex-col items-center gap-3", paused && "hero-paused")}>
      {children}
      <button
        type="button"
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
        className="grid size-11 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hidden"
      >
        <Icon aria-hidden className="size-4" />
        <span className="sr-only">{pauseLabel}</span>
      </button>
    </figure>
  );
}
