/**
 * Which take of each shot goes into the video. Director picks the best-scored take (the
 * API's `pickedTakeId`); until a take is scored, the newest plays, though never one
 * Director couldn't review while another can: a failed take may be one with nothing in
 * it, which can't play and would keep the video from saving. The member's own
 * choice beats it: one they made while shooting ("use the second one", the API's
 * `chosenTakeId`), and over that one they make here, with a tap on any take of the shot
 * or stepping through them in the order they filmed them. What plays is what a saved cut
 * records.
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
  return (
    find(picks[shot.index]) ??
    find(shot.chosenTakeId) ??
    find(shot.pickedTakeId) ??
    shot.takes.find((take) => take.status !== "failed") ??
    shot.takes[0]
  );
}

/**
 * The shot's takes as the editor lists them: the member's choice from the shoot first,
 * then Director's pick, then the rest in the order filmed. Every attempt is there, so
 * one tap swaps to any of them.
 */
export function picksFirst(shot: DirectorShot): DirectorTake[] {
  const rank = (take: DirectorTake) => {
    if (take.id === shot.chosenTakeId) {
      return 0;
    }
    return take.id === shot.pickedTakeId ? 1 : 2;
  };
  // sort is stable: within a rank, the filmed order stands.
  return takesInOrder(shot).sort((a, b) => rank(a) - rank(b));
}

/** Director's pick for every shot that has one: "Go back to Director's picks". */
export function directorsPicks(shots: readonly DirectorShot[]): Picks {
  return Object.fromEntries(
    shots.flatMap((shot) => (shot.pickedTakeId ? [[shot.index, shot.pickedTakeId]] : [])),
  );
}

/** Whether any shot plays something other than Director's pick (one that has a pick). */
export function awayFromDirectorsPicks(
  shots: readonly DirectorShot[],
  played: ReadonlyMap<number, DirectorTake>,
): boolean {
  return shots.some(
    (shot) => shot.pickedTakeId !== null && played.get(shot.index)?.id !== shot.pickedTakeId,
  );
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
