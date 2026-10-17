import { AiServiceError } from "@repo/ai-client";
import { AppError } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { callAi } from "./ai.service";

async function refusal(work: () => Promise<unknown>) {
  const error = await callAi(work).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("a call to the AI service that fails", () => {
  it("lets this API's own error through as it is", async () => {
    const own = new AppError("SHORT_NOT_FOUND");
    await expect(refusal(() => Promise.reject(own))).resolves.toBe(own);
  });

  it("passes on a code clients understand, with its params", async () => {
    const error = await refusal(() =>
      Promise.reject(new AiServiceError(404, "FEATURE_DISABLED", { feature: "director" })),
    );
    expect(error).toMatchObject({ code: "FEATURE_DISABLED", params: { feature: "director" } });
  });

  it("hides anything else behind UPSTREAM_UNAVAILABLE, keeping the cause", async () => {
    const internal = new AiServiceError(500, "INTERNAL");
    const error = await refusal(() => Promise.reject(internal));
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", params: { service: "ai" } });
    expect(error.cause).toBe(internal);
  });
});
