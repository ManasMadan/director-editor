/**
 * Changing the shots of a template the member described: moving one, adding one, and
 * whether every shot still says what happens and where. The API puts the shots back to
 * back when it saves them, so only their order and lengths matter here.
 */
import type { ServedShotPlan } from "@repo/contracts/api";

export type ShotDraft = ServedShotPlan["shots"][number];

/** `shots` with the one at `index` moved `by` places (kept inside the list). */
export function moved<T>(shots: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  const next = [...shots];
  const shot = next[index];
  if (shot === undefined || target < 0 || target >= next.length) {
    return next;
  }
  next.splice(index, 1);
  next.splice(target, 0, shot);
  return next;
}

/**
 * A new shot at the end, set up like the last one (its camera, framing and how the
 * phone is held) with the member's own words: nothing said, one step, its own card to
 * be drawn once it's saved.
 */
export function newShot(
  shots: readonly ShotDraft[],
  words: { title: string; scene: string },
): ShotDraft {
  const last = shots.at(-1);
  if (!last) {
    throw new Error("a plan always has a shot");
  }
  const { storyboardUrl: _card, previewUrl: _preview, ...setup } = last;
  return {
    ...setup,
    title: words.title,
    scene: words.scene,
    sceneLandmark: null,
    script: [],
    steps: [{ atSeconds: 0, instruction: words.scene, cameraMove: "static" }],
  };
}

/** Every shot says what happens and where. */
export const shotsValid = (shots: readonly ShotDraft[]) =>
  shots.length > 0 && shots.every((shot) => shot.title.trim() && shot.scene.trim());
