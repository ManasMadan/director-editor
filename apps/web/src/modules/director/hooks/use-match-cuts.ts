"use client";

import { useMatchCutAlignments } from "@repo/client/api/director/match-cuts";
import type { MatchCutAlignment } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { useMemo } from "react";
import type { Clip } from "../lib/edit";
import {
  alignClips,
  type MatchCut,
  type MatchCutTransform,
  matchCutsOf,
  type PlanLike,
  transformsOf,
} from "../lib/match-cuts";

/** A match cut and how lining it up is going. */
export type MatchCutState =
  | { cut: MatchCut; step: "aligning" }
  | { cut: MatchCut; step: "failed" }
  | { cut: MatchCut; step: "done"; alignment: MatchCutAlignment };

/**
 * The edit's match cuts lined up, automatically, as soon as both takes either side are
 * picked and reviewed: the clips with the cut points moved, the transform each aligned
 * clip is drawn with, and each cut's state for its note. Picking another take asks again.
 */
export function useMatchCuts(
  videoId: string,
  plan: PlanLike,
  clips: readonly Clip[],
): { clips: Clip[]; transforms: Map<number, MatchCutTransform>; cuts: MatchCutState[] } {
  const cuts = useMemo(
    () => matchCutsOf(videoIdSchema.parse(videoId), plan, clips),
    [videoId, plan, clips],
  );
  const asks = useMemo(() => cuts.map((cut) => cut.ask), [cuts]);
  const results = useMatchCutAlignments(asks);
  const aligned = useMemo(() => {
    const byClip = new Map<number, MatchCutAlignment>();
    cuts.forEach((cut, index) => {
      const alignment = results[index]?.alignment;
      if (alignment) {
        byClip.set(cut.into, alignment);
      }
    });
    return byClip;
  }, [cuts, results]);
  return {
    clips: useMemo(() => alignClips(clips, aligned), [clips, aligned]),
    transforms: useMemo(() => transformsOf(aligned), [aligned]),
    cuts: cuts.map((cut, index): MatchCutState => {
      const result = results[index];
      if (result?.alignment) {
        return { cut, step: "done", alignment: result.alignment };
      }
      return { cut, step: result?.failed ? "failed" : "aligning" };
    }),
  };
}
