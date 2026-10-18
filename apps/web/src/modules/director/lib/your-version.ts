/**
 * The member's version of the plan: what Director changed in a shot from what they said
 * ("what if I do it with my grandma"), and the shot as it reads with those changes. The
 * shoot screen shows and records this version; the original stays in the plan.
 */
import type { Shot } from "@repo/contracts/api";
import type { LiveAdaptation } from "@repo/contracts/live";

/** Each changed shot's version, by its index. */
export type Adaptations = Readonly<Record<number, LiveAdaptation>>;

export const NO_ADAPTATIONS: Adaptations = {};

/** A row of the shot card that can be the member's own. */
export type ChangedRow = "where" | "do" | "say";

/**
 * Director changed a shot: what it changed replaces what was there, and what it left out
 * stays as it was (an earlier change, or the original).
 */
export function adapted(adaptations: Adaptations, change: LiveAdaptation): Adaptations {
  const { shot } = change;
  return { ...adaptations, [shot]: { ...adaptations[shot], ...change } };
}

/** Every change so far, for a fresh connection to know them. */
export function adaptationList(adaptations: Adaptations): LiveAdaptation[] {
  return Object.values(adaptations);
}

/**
 * The shot as the member has it: their place as the scene, what they do as the first
 * step, and their line said across the whole shot (its timing was the original's).
 */
export function yourVersion(
  shot: Shot,
  adaptation: LiveAdaptation | undefined,
): { shot: Shot; changed: ReadonlySet<ChangedRow> } {
  if (!adaptation) {
    return { shot, changed: new Set<ChangedRow>() };
  }
  const { where, action, line } = adaptation;
  const [first, ...rest] = shot.steps;
  const steps = action && first ? [{ ...first, instruction: action }, ...rest] : shot.steps;
  const changed = new Set<ChangedRow>();
  if (where) {
    changed.add("where");
  }
  if (action) {
    changed.add("do");
  }
  if (line) {
    changed.add("say");
  }
  return {
    shot: {
      ...shot,
      scene: where ?? shot.scene,
      steps,
      pose: action && !first ? { ...shot.pose, description: action } : shot.pose,
      script: line
        ? [{ startSeconds: 0, endSeconds: shot.durationSeconds, text: line }]
        : shot.script,
    },
    changed,
  };
}
