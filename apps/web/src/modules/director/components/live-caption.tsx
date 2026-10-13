"use client";

import { cn } from "@repo/ui/lib/utils";
import type { Line } from "../hooks/use-live-director";
import { GLASS } from "./live-hud";

/** Director's mark: a small aurora orb that swirls while it talks. */
function Orb({ talking }: { talking: boolean }) {
  return (
    <span aria-hidden className="relative mt-0.5 flex size-7 shrink-0">
      <span
        className={cn(
          "absolute inset-0 rounded-full bg-[conic-gradient(from_90deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))]",
          talking
            ? "animate-[live-drift_1.6s_linear_infinite]"
            : "animate-[live-drift_8s_linear_infinite]",
        )}
      />
      <span className="absolute inset-[3px] rounded-full bg-studio/40 backdrop-blur-sm" />
    </span>
  );
}

const MOOD_EDGE = {
  guide: "ring-studio-foreground/12",
  cheer: "ring-guide/70",
  warn: "ring-guide-warn/70",
} as const;

/**
 * What Director just said, as a caption at the foot of the viewport (so it can be read
 * from across a room, and by anyone who can't hear it), and what it heard the member say.
 * Each new line rises into place.
 */
export function DirectorCaption({
  line,
  talking,
  heard,
  listening,
}: {
  line: Line | null;
  talking: boolean;
  /** The member's words as Director hears them, while they talk. */
  heard: string;
  listening: boolean;
}) {
  if (!line && !heard) {
    return null;
  }
  return (
    <div className="live-motion flex flex-col gap-1.5" aria-live="polite">
      {line ? (
        <div
          key={line.key}
          className={cn(
            "flex animate-[live-rise_380ms_cubic-bezier(.2,.8,.2,1)_both] items-start gap-2.5 rounded-3xl px-3.5 py-3",
            GLASS,
            MOOD_EDGE[line.mood],
          )}
        >
          <Orb talking={talking} />
          <p className="text-[15px] leading-snug font-semibold text-balance">{line.text}</p>
        </div>
      ) : null}
      {heard && listening ? (
        <p className="ml-auto max-w-[85%] animate-[live-rise_300ms_ease-out_both] rounded-2xl rounded-br-md bg-studio-foreground/90 px-3 py-1.5 text-sm font-medium text-studio">
          {heard}
        </p>
      ) : null}
    </div>
  );
}
