"use client";

import type { SceneCheck, Shot } from "@repo/contracts/api";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";
import { hush, say } from "../lib/speech";

/** Says `text` each time it changes to something new (nothing for null). */
function useSpoken(text: string | null, enabled: boolean) {
  const locale = useLocale();
  useEffect(() => {
    if (enabled && text) {
      say(text, locale);
    }
  }, [text, enabled, locale]);
}

/**
 * Director's voice on set. Before a take: what the shot is and where to be, then each new
 * direction from the scene check. During one: the countdown, and each step as it comes,
 * but only while the microphone isn't recording (a take with your voice shouldn't have
 * Director's in it; the steps stay on screen).
 */
export function useDirections({
  shot,
  enabled,
  scene,
  countdown,
  step,
  recording,
  micOn,
}: {
  shot: Shot;
  enabled: boolean;
  scene: SceneCheck | null;
  countdown: number | null;
  step: Shot["steps"][number] | undefined;
  recording: boolean;
  micOn: boolean;
}) {
  const t = useTranslations("director.shoot");
  useEffect(() => () => hush(), []);
  // A take with your voice starts in silence: whatever Director was saying stops.
  useEffect(() => {
    if (recording && micOn) {
      hush();
    }
  }, [recording, micOn]);
  useSpoken(t("getReady", { title: shot.title, scene: shot.scene }), enabled);
  const direction = scene?.inPlace ? t("scene.inPlace") : scene?.instruction;
  useSpoken(recording ? null : (direction ?? null), enabled);
  useSpoken(countdown === null ? null : t("countdown", { seconds: countdown }), enabled);
  useSpoken(recording && !micOn ? t("action") : null, enabled);
  useSpoken(recording && !micOn && step ? step.instruction : null, enabled);
}
