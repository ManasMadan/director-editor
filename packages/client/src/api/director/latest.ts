/** Whether Director is still reviewing a take: what the takes and shots are followed for. */
import type { DirectorTake } from "@repo/contracts/api";

export const takeInProgress = (take: DirectorTake) =>
  take.status === "pending" || take.status === "reviewing";
