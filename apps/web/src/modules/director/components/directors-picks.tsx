"use client";

import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { RotateCcw, SparkleIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo } from "react";
import { awayFromDirectorsPicks, directorsPicks, type Picks, pickedTakes } from "../lib/picks";

/** Director's four-point sparkle in the aurora's colours: Gemini picked this one. */
function PickSparkle({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className}>
      <defs>
        <linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--aurora-1)" />
          <stop offset="50%" stopColor="var(--aurora-2)" />
          <stop offset="100%" stopColor="var(--aurora-3)" />
        </linearGradient>
      </defs>
      <SparkleIcon fill={`url(#${gradient})`} stroke="none" />
    </svg>
  );
}

/**
 * What a take's tile says about picking it: the member's own choice from the shoot,
 * Director's pick with its one-line reason (always shown, so the member sees why without
 * opening anything), and a take the post-session pass found in the footage.
 */
export function PickBadges({ shot, take }: { shot: DirectorShot; take: DirectorTake }) {
  const t = useTranslations("director.editor");
  const directors = take.id === shot.pickedTakeId;
  return (
    <>
      {take.id === shot.chosenTakeId ? (
        <span className="text-xs font-semibold">{t("yourPick")}</span>
      ) : null}
      {directors ? (
        <span className="flex items-center gap-1 text-xs font-medium">
          <PickSparkle className="size-3.5 shrink-0" />
          {t("directorsPick")}
        </span>
      ) : null}
      {directors && take.reason ? (
        <span className="text-xs leading-snug text-studio-foreground/85">{take.reason}</span>
      ) : null}
      {take.origin === "pass" ? (
        <span className="text-xs text-studio-foreground/70">{t("foundLater")}</span>
      ) : null}
    </>
  );
}

/**
 * "Go back to Director's picks": shown once any shot plays something other than
 * Director's pick, whether the member chose it while shooting or tapped it here. One
 * tap, undoable like every other change in the editor.
 */
export function BackToPicks({
  shots,
  picks,
  onReset,
}: {
  shots: readonly DirectorShot[];
  picks: Picks;
  onReset: (picks: Picks) => void;
}) {
  const t = useTranslations("director.editor");
  const away = useMemo(
    () => awayFromDirectorsPicks(shots, pickedTakes(shots, picks)),
    [shots, picks],
  );
  if (!away) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 self-start px-4 text-studio-foreground/80"
      onClick={() => onReset(directorsPicks(shots))}
    >
      <RotateCcw className="size-4" aria-hidden />
      {t("backToPicks")}
    </Button>
  );
}
