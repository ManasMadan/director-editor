/**
 * A plan's shots with the member's takes of each. Takes are never replaced, so a shot
 * collects every attempt; the one picked for it is the best-scored (the newest of a tie),
 * and the shot needs a retake while that one scored below DIRECTOR_RETAKE_BELOW. A shot
 * with no scored take yet has nothing picked and asks for no retake: it's still waiting
 * for its first take or its review. A take the member chose while shooting ("use the
 * second one") is the shot's choice, which plays over Director's pick; Director's pick
 * still shows, with its reason, so the member sees both.
 */
import { DIRECTOR_RETAKE_BELOW, type DirectorShot, type DirectorTake } from "@repo/contracts/api";

/** Newest first: what a shot's takes are listed in, and what breaks a tie in score. */
const newestFirst = (a: DirectorTake, b: DirectorTake) =>
  b.createdAt.getTime() - a.createdAt.getTime();

/** The best-scored of a shot's takes (listed newest first), with its score. */
function picked(takes: DirectorTake[]): { id: DirectorTake["id"]; score: number } | null {
  let best: { id: DirectorTake["id"]; score: number } | null = null;
  for (const { id, score } of takes) {
    // Strictly better only: an older take of the same score never displaces the newer.
    if (score !== null && (best === null || score > best.score)) {
      best = { id, score };
    }
  }
  return best;
}

export function shotsOf(shotCount: number, takes: DirectorTake[]): DirectorShot[] {
  const sorted = [...takes].sort(newestFirst);
  return Array.from({ length: shotCount }, (_, index) => {
    const ofShot = sorted.filter((take) => take.shotIndex === index);
    const pick = picked(ofShot);
    return {
      index,
      takes: ofShot,
      pickedTakeId: pick === null ? null : pick.id,
      // The AI service keeps one choice a shot; `find` takes the first all the same.
      chosenTakeId: ofShot.find((take) => take.chosen)?.id ?? null,
      needsRetake: pick !== null && pick.score < DIRECTOR_RETAKE_BELOW,
    };
  });
}
