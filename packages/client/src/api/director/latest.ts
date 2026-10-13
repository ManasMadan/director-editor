/** Each shot's newest take: the one that goes into the final video. */
import type { DirectorTake } from "@repo/contracts/api";

export function latestTakes(takes: DirectorTake[]): Map<number, DirectorTake> {
  const latest = new Map<number, DirectorTake>();
  for (const take of takes) {
    const seen = latest.get(take.shotIndex);
    if (!seen || take.createdAt > seen.createdAt) {
      latest.set(take.shotIndex, take);
    }
  }
  return latest;
}

export const takeInProgress = (take: DirectorTake) =>
  take.status === "pending" || take.status === "reviewing";
