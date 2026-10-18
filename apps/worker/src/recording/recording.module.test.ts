import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) {
    vi.stubEnv(key, value);
  }
  return import("./recording.module");
}

describe("the AI service's client, for cutting takes", () => {
  it("is there with both AI_URL and AI_SERVICE_SECRET, and not without either", async () => {
    const both = await load({ AI_URL: "http://ai.test", AI_SERVICE_SECRET: "s".repeat(32) });
    expect(both.createClipClient()?.director.clip).toBeTypeOf("function");
    vi.resetModules();
    const neither = await load({ AI_URL: "", AI_SERVICE_SECRET: "" });
    expect(neither.createClipClient()).toBeNull();
  });

  it("refuses one without the other", async () => {
    const half = await load({ AI_URL: "http://ai.test", AI_SERVICE_SECRET: "" });
    expect(() => half.createClipClient()).toThrow("AI_URL and AI_SERVICE_SECRET go together");
  });

  it("leaves recorded attempts waiting when the worker has neither it nor storage", async () => {
    const { ClipProcessor } = await import("./clip.processor");
    const { orgIdSchema, recordingAttemptIdSchema } = await import("@repo/contracts/ids");
    const id = "0199f3a0-0000-7000-8000-000000000001";
    const unconfigured = Reflect.construct(ClipProcessor, [null, null, null, null, null]);
    await expect(
      unconfigured.clip(orgIdSchema.parse(id), recordingAttemptIdSchema.parse(id)),
    ).rejects.toThrow("recording needs storage and the AI service");
  });
});
