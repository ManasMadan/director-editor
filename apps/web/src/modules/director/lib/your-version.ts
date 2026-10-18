/**
 * The member's version of the plan (@repo/contracts your-version.ts): what Director
 * remembers ("Inside", "One angle"), how it changed each shot from what they said, and the
 * shots they skipped or left as gaps for the editor; and each shot as it reads with those
 * changes. The shoot screen shows and records this version, and the editor saves it; the
 * original stays in the plan. Every change here is a pure step, so the screen, the relay
 * and the server all hold the same version.
 */
import type { MemoryNote, Shot, ShotVersion, YourVersion } from "@repo/contracts/api";
import { applyShotVersion, MEMORY_MAX_NOTES } from "@repo/contracts/api";
import type { LiveAdaptation, RestorableRow } from "@repo/contracts/live";

/** A row of the shot card that can be the member's own. */
export type ChangedRow = "where" | "do" | "say" | "framing";

/** The version's field each card row shows. */
export const ROW_FIELD: Record<ChangedRow, RestorableRow> = {
  where: "where",
  do: "action",
  say: "line",
  framing: "framing",
};

/** The member's version of shot `index`, if Director changed it. */
export function adaptationOf(version: YourVersion, index: number): ShotVersion | undefined {
  return version.shots.find((shot) => shot.shot === index);
}

/** A version's shots with `shot` replaced (or dropped, when it changes nothing any more). */
function withShot(version: YourVersion, index: number, shot: ShotVersion | null): YourVersion {
  const others = version.shots.filter((changed) => changed.shot !== index);
  const { shot: _, ...rows } = shot ?? { shot: index };
  const shots = Object.keys(rows).length > 0 && shot ? [...others, shot] : others;
  return { ...version, shots: shots.toSorted((a, b) => a.shot - b.shot) };
}

/**
 * Director changed a shot: what it changed replaces what was there, and what it left out
 * stays as it was (an earlier change, or the original).
 */
export function adapted(version: YourVersion, change: LiveAdaptation): YourVersion {
  return withShot(version, change.shot, { ...adaptationOf(version, change.shot), ...change });
}

/** One row of a shot back to the original's (the member tapped ↺ on the card). */
export function restoredRow(version: YourVersion, index: number, row: RestorableRow): YourVersion {
  const shot = adaptationOf(version, index);
  if (!shot) {
    return version;
  }
  const { [row]: _, ...rest } = shot;
  return withShot(version, index, rest);
}

/** The whole shot back to the original: its changes gone, and filmed again if it was skipped. */
export function restored(version: YourVersion, index: number): YourVersion {
  const without = withShot(version, index, null);
  return {
    ...without,
    skipped: without.skipped.filter((shot) => shot !== index),
    gaps: without.gaps.filter((shot) => shot !== index),
  };
}

/** A shot left out of their video. */
export function skipped(version: YourVersion, index: number): YourVersion {
  return version.skipped.includes(index)
    ? version
    : { ...version, skipped: [...version.skipped, index].toSorted((a, b) => a - b) };
}

/** Something Director remembers: one chip per note, the newest kept when there are too many. */
export function remembered(version: YourVersion, note: MemoryNote): YourVersion {
  const others = version.notes.filter(
    (kept) => kept.note.toLowerCase() !== note.note.toLowerCase(),
  );
  return { ...version, notes: [...others, note].slice(-MEMORY_MAX_NOTES) };
}

/** A note Director no longer holds to. */
export function forgotten(version: YourVersion, note: string): YourVersion {
  const notes = version.notes.filter((kept) => kept.note.toLowerCase() !== note.toLowerCase());
  return { ...version, notes };
}

// Which shots the member films, as the relay reads it too.
export { films, nearestFilmed, nextFilmed } from "@repo/contracts/api";

const CARD_ROWS: readonly ChangedRow[] = ["where", "do", "say", "framing"];

function changedRows(adaptation: ShotVersion): Set<ChangedRow> {
  return new Set(CARD_ROWS.filter((row) => adaptation[ROW_FIELD[row]] !== undefined));
}

/**
 * The shot as the member has it: their place as the scene, what they do as the first
 * step, their line said across the whole shot (its timing was the original's), their
 * framing in words, and their camera.
 */
export function yourVersion(
  shot: Shot,
  adaptation: ShotVersion | undefined,
): { shot: Shot; changed: ReadonlySet<ChangedRow> } {
  if (!adaptation) {
    return { shot, changed: new Set<ChangedRow>() };
  }
  return { shot: applyShotVersion(shot, adaptation), changed: changedRows(adaptation) };
}
