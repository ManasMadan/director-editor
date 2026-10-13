"use client";

import type { Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { type Tilt, tiltInRange, tiltOffset } from "../lib/tilt";

/** How far the bubble may travel from the middle, in degrees off the target. */
const RANGE = 30;

/** The hint for the axis that's furthest off. */
function hint(offset: Tilt) {
  if (Math.abs(offset.pitch) >= Math.abs(offset.roll)) {
    return offset.pitch > 0 ? "tipUp" : "tipDown";
  }
  return offset.roll > 0 ? "leanRight" : "leanLeft";
}

/**
 * A spirit level for the shot's phone angle: the bubble drifts with the tilt and turns
 * solid green inside the target's tolerance.
 */
export function BubbleLevel({
  tilt,
  target,
  onAsk,
}: {
  tilt: Tilt | null;
  target: Shot["phoneAngle"];
  onAsk: (() => void) | null;
}) {
  const t = useTranslations("director.shoot");
  if (onAsk) {
    return (
      <button
        type="button"
        onClick={onAsk}
        className="rounded-full bg-studio/60 px-3 py-1.5 text-xs backdrop-blur"
      >
        {t("useTilt")}
      </button>
    );
  }
  if (!tilt) {
    return (
      <p className="rounded-full bg-studio/60 px-3 py-1.5 text-xs backdrop-blur">
        {t("level.unavailable")}
      </p>
    );
  }
  const offset = tiltOffset(tilt, target);
  const level = tiltInRange(tilt, target);
  const x = Math.max(-1, Math.min(1, -offset.roll / RANGE));
  const y = Math.max(-1, Math.min(1, offset.pitch / RANGE));
  const tolerance = Math.min(1, target.tolerance / RANGE);
  return (
    <div className="flex items-center gap-2 rounded-full bg-studio/60 py-1 pr-3 pl-1 backdrop-blur">
      <div
        role="img"
        aria-label={t("level.label")}
        className="relative size-12 rounded-full border-2 border-studio-foreground/40"
      >
        <span
          className="absolute rounded-full border border-dashed border-studio-foreground/50"
          style={{
            inset: `${50 - tolerance * 50}%`,
          }}
        />
        <span
          className={cn(
            "absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
            level ? "bg-guide" : "border-2 border-guide-warn",
          )}
          style={{ left: `${50 + x * 42}%`, top: `${50 + y * 42}%` }}
        />
      </div>
      <p
        className={cn("text-xs font-medium", level ? "text-guide" : "text-guide-warn")}
        aria-live="polite"
      >
        {level ? t("level.ok") : t(`level.${hint(offset)}`)}
      </p>
    </div>
  );
}
