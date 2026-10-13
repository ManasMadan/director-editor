"use client";

import type { SceneCheck } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import { MapPin, PersonStanding, ScanFace } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { PoseState } from "../hooks/use-pose";
import type { FramingHint } from "../lib/framing";

function Chip({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 rounded-full bg-studio/70 px-3 py-1.5 text-xs font-medium backdrop-blur",
        ok ? "text-guide" : "text-guide-warn",
      )}
    >
      {children}
    </p>
  );
}

function SceneCard({ scene, check }: { scene: string; check: SceneCheck | null }) {
  const t = useTranslations("director.shoot");
  const light =
    check && check.lighting !== "good" ? ` · ${t(`scene.lighting.${check.lighting}`)}` : "";
  return (
    <div className="rounded-2xl bg-studio/70 px-3 py-2 backdrop-blur">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <MapPin className="size-4 text-record" aria-hidden />
        {scene}
      </p>
      {check ? (
        <p className="mt-0.5 text-sm text-studio-foreground/80">
          {check.inPlace ? t("scene.inPlace") : check.instruction}
          {light}
        </p>
      ) : null}
    </div>
  );
}

const POSE_MESSAGE = {
  loading: "pose.loading",
  failed: "pose.failed",
  ready: "pose.match",
} as const;

function PoseChip({ state, matched }: { state: Exclude<PoseState, "off">; matched: boolean }) {
  const t = useTranslations("director.shoot");
  return (
    <Chip ok={matched}>
      <PersonStanding className="size-4" aria-hidden />
      {t(matched ? "pose.matched" : POSE_MESSAGE[state])}
    </Chip>
  );
}

/** Where the member stands against the shot: the scene, the framing and the pose. */
export function GuideChips({
  scene,
  sceneCheck,
  framing,
  pose,
  poseMatched,
}: {
  scene: string;
  sceneCheck: SceneCheck | null;
  framing: FramingHint | null;
  pose: PoseState;
  poseMatched: boolean;
}) {
  const t = useTranslations("director.shoot");
  return (
    <div className="flex flex-col items-start gap-2" aria-live="polite">
      <SceneCard scene={scene} check={sceneCheck} />
      {framing ? (
        <Chip ok={framing === "in-frame"}>
          <ScanFace className="size-4" aria-hidden />
          {t(`framing.${framing}`)}
        </Chip>
      ) : null}
      {pose === "off" ? null : <PoseChip state={pose} matched={poseMatched} />}
    </div>
  );
}
