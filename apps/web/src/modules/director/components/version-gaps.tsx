"use client";

import type { ShotPlan, YourVersion } from "@repo/contracts/api";
import { useTranslations } from "next-intl";

/**
 * The shots the member's version doesn't film, above the editor's board: gaps the edit
 * fills (from another angle they chose not to film, say) and shots they skipped. Neither
 * is in the video they save.
 */
export function VersionGaps({ plan, version }: { plan: ShotPlan; version: YourVersion }) {
  const t = useTranslations("director.editor.version");
  const rows = [
    ...version.gaps.map((index) => ({ index, kind: "gap" as const })),
    ...version.skipped.map((index) => ({ index, kind: "skipped" as const })),
  ].filter(({ index }) => plan.shots[index] !== undefined);
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t("label")} className="flex flex-col gap-1 px-4 text-xs">
      {rows.map(({ index, kind }) => (
        <li key={index} className="flex items-baseline gap-2">
          <span aria-hidden className="font-semibold text-studio-foreground/80 tabular-nums">
            {kind === "gap" ? "◇" : "–"}
          </span>
          <span className="text-studio-foreground/70">
            {t(kind, { index: index + 1, title: plan.shots[index]?.title ?? "" })}
          </span>
        </li>
      ))}
    </ul>
  );
}
