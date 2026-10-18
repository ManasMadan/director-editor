/**
 * What the library and a template's page show of a plan: how far indexing got, the shape
 * of its shots, how to hold the phone, and where filming picks up.
 */

/** The steps indexing goes through, as the library draws them. */
export const INDEX_STEPS = ["queued", "watching", "writing", "ready"] as const;
export type IndexStep = (typeof INDEX_STEPS)[number];

/** The step each stage is, and each status for a stage this page doesn't know yet. */
const STAGE_STEP: Record<string, IndexStep> = {
  queued: "queued",
  watching: "watching",
  writing: "writing",
  ready: "ready",
};
const STATUS_STEP: Record<string, IndexStep> = {
  pending: "queued",
  analyzing: "watching",
  ready: "ready",
};

/**
 * The step a plan is on, or "failed". Takes plain strings: the AI service may report a
 * finer stage than this page was built with, which then falls back on the plan's status
 * instead of breaking the page.
 */
export function indexStep(status: string, stage: string): IndexStep | "failed" {
  if (status === "failed") {
    return "failed";
  }
  return STAGE_STEP[stage] ?? STATUS_STEP[status] ?? "queued";
}

/** Each shot's share of the short, for the strip that draws its rhythm. */
export function shotRhythm<K extends string>(shots: { durationSeconds: number; kind: K }[]) {
  const total = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  return shots.map((shot) => ({ share: shot.durationSeconds / total, kind: shot.kind }));
}

/** How the camera points: level within the shot's tolerance, else up or down by how much. */
export function angleOf({ pitch, tolerance }: { pitch: number; tolerance: number }) {
  if (Math.abs(pitch) <= tolerance) {
    return { tilt: "level", degrees: 0 } as const;
  }
  return { tilt: pitch > 0 ? "up" : "down", degrees: Math.round(Math.abs(pitch)) } as const;
}

/**
 * Where filming starts: the first shot with no take once the member has filmed any (and
 * not all) of them, the first shot otherwise. `started` says which, for the button's words.
 */
export function nextShot(shots: { index: number; takes: unknown[] }[] | undefined) {
  const missing = shots?.find((shot) => shot.takes.length === 0);
  const started = Boolean(missing && shots?.some((shot) => shot.takes.length > 0));
  return { index: started && missing ? missing.index : 0, started };
}
