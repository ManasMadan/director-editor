/**
 * Calls to the Python AI service through its generated client (packages/ai-client). This
 * API has authenticated the user and checked their membership; each call to the service
 * carries a token naming them and the workspace.
 *
 * Service errors are mapped to this API's error codes; anything unexpected becomes
 * UPSTREAM_UNAVAILABLE, never the service's own message.
 */

import { type AiCaller, AiServiceError, createAiClient } from "@repo/ai-client";
import type { ErrorCode } from "@repo/contracts/errors";
import type { OrgId, UserId } from "@repo/contracts/ids";
import { AppError, currentContext } from "@repo/nest-common";
import { env } from "../../env";

// Error codes the service may answer with that clients understand.
const PASSED_ON = new Set<ErrorCode>([
  "AI_BUDGET_EXCEEDED",
  "FEATURE_DISABLED",
  "VALIDATION_FAILED",
  "UPSTREAM_UNAVAILABLE",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_SHOT_NOT_FOUND",
  "DIRECTOR_TAKE_KIND_MISMATCH",
]);

/** The AI service's client, when it is configured (the `ai` feature). */
const aiClient =
  env.AI_URL && env.AI_SERVICE_SECRET
    ? createAiClient({ baseUrl: env.AI_URL, secret: env.AI_SERVICE_SECRET })
    : null;

/** Who a call to the AI service is for, with this request's id. */
export function aiCaller(userId: UserId, orgId: OrgId): AiCaller {
  return { userId, orgId, requestId: currentContext()?.requestId };
}

/**
 * Runs a call to the AI service: FEATURE_DISABLED when it isn't configured, and its
 * errors mapped to this API's codes.
 */
export async function callAi<T>(work: (ai: AiClient) => Promise<T>): Promise<T> {
  if (!aiClient) {
    throw new AppError("FEATURE_DISABLED", { params: { feature: "ai" } });
  }
  try {
    return await work(aiClient);
  } catch (error) {
    throw toAppError(error);
  }
}

type AiClient = ReturnType<typeof createAiClient>;

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof AiServiceError && PASSED_ON.has(error.code)) {
    return new AppError(error.code, { params: error.params });
  }
  return new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "ai" }, cause: error });
}
