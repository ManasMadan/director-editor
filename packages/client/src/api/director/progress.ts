/** Whether Director is still working a plan out: the plan and library queries follow it then. */
import type { DirectorPlan } from "@repo/contracts/api";

export const planInProgress = (plan: DirectorPlan | undefined) =>
  plan?.status === "pending" || plan?.status === "analyzing";
