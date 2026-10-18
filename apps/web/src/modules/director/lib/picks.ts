/**
 * Which take of each shot goes into the video. Director picks the best-scored take (the
 * API's `pickedTakeId`); until a take is scored, the newest plays. The member can pick
 * any other take of the shot instead, stepping through them in the order they filmed
 * them, and their pick is what a saved cut records.
 */
import type { DirectorCut, DirectorShot, DirectorTake } from "@repo/contracts/api";
import type { DirectorTakeId } from "@repo/contracts/ids";

/** The member's own picks, by shot index: only the shots they changed. */
export type Picks = Readonly<Record<number, DirectorTakeId>>;

/** Oldest first, so take 1 is the first one filmed (the API lists them newest first). */
export function takesInOrder(shot: DirectorShot): DirectorTake[] {
  return [...shot.takes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** The take's number in its shot, from 1. */
export function takeNumber(shot: DirectorShot, takeId: DirectorTakeId): number {
  return takesInOrder(shot).findIndex((take) => take.id === takeId) + 1;
}

function pickedTake(shot: DirectorShot, picks: Picks): DirectorTake | undefined {
  const find = (takeId: DirectorTakeId | null | undefined) =>
    shot.takes.find((take) => take.id === takeId);
  return find(picks[shot.index]) ?? find(shot.pickedTakeId) ?? shot.takes[0];
}

/** The take each filmed shot plays, by shot index. */
export function pickedTakes(
  shots: readonly DirectorShot[],
  picks: Picks,
): Map<number, DirectorTake> {
  const played = new Map<number, DirectorTake>();
  for (const shot of shots) {
    const take = pickedTake(shot, picks);
    if (take) {
      played.set(shot.index, take);
    }
  }
  return played;
}

/** The take filmed just before (-1) or after (1) the one playing, or null at either end. */
export function stepPick(shot: DirectorShot, picks: Picks, step: -1 | 1): DirectorTakeId | null {
  const ordered = takesInOrder(shot);
  const at = ordered.findIndex((take) => take.id === pickedTake(shot, picks)?.id);
  return ordered[at + step]?.id ?? null;
}

/** The picks a saved cut records: the take each filmed shot plays. */
export function cutPicks(played: ReadonlyMap<number, DirectorTake>): DirectorCut["picks"] {
  return Object.fromEntries([...played].map(([index, take]) => [index, take.id]));
}
