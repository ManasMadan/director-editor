/**
 * The live call's wiring (liveCallOptions), directly: the call itself is unit-tested
 * against a stand-in Live API (src/modules/live/live.test.ts), and who may start one
 * through the real server in apps/api/test/director.integration.test.ts. Neither gets
 * as far as spendCallLimit or recordCallStarted (both need a real Gemini connection), so
 * this is where those two closures are proven to delegate to the right thing.
 */
import type { IncomingMessage } from "node:http";
import { orgIdSchema, userIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { liveCallOptions } from "./server";

const userId = userIdSchema.parse("5e2d7c3a-1b4f-4a8e-9c6d-7f0a2b3c4d5e");
const orgId = orgIdSchema.parse("0b9f5c1e-3f4a-4c55-8f0e-2a6d1c7e9b10");
const videoId = videoIdSchema.parse("dQw4w9WgXcQ");
const caller = { orgId, userId, role: "member" as const, signedInAt: new Date(0), demo: false };

function options(overrides: Partial<Parameters<typeof liveCallOptions>[0]> = {}) {
  return liveCallOptions({
    caller: () => Promise.resolve(caller),
    director: { planOf: vi.fn(() => Promise.reject(new Error("not needed"))) },
    analytics: { record: vi.fn() },
    calls: { take: vi.fn(() => Promise.resolve()) },
    logger: { warn: vi.fn(), error: vi.fn() },
    activity: vi.fn(),
    ...overrides,
  });
}

describe("the live call's wiring", () => {
  it("asks the director service for the caller's plan in their workspace, without its media", async () => {
    const planOf = vi.fn(() => Promise.reject(new Error("not needed")));
    const live = options({ director: { planOf } });
    await expect(live.plan(caller, videoId)).rejects.toThrow("not needed");
    expect(planOf).toHaveBeenCalledWith(userId, orgId, videoId);
  });

  it("spends the caller's call against the rate limiter", async () => {
    const take = vi.fn(() => Promise.resolve());
    const live = options({ calls: { take } });
    await live.spendCallLimit(userId);
    expect(take).toHaveBeenCalledWith(userId);
  });

  it("records a started call as a call_started analytics event", () => {
    const record = vi.fn();
    const live = options({ analytics: { record } });
    live.recordCallStarted(userId, videoId);
    expect(record).toHaveBeenCalledWith("call_started", { userId, videoId });
  });

  it("writes the call's activity through the API's recorder, in the upgrade's own context", () => {
    const activity = vi.fn();
    const live = options({ activity });
    expect(live.activity).toBe(activity);
    const upgrade = { headers: {}, socket: { remoteAddress: "203.0.113.9" } };
    expect(live.context(upgrade as unknown as IncomingMessage)).toMatchObject({
      requestId: expect.any(String),
      ip: "203.0.113.9",
    });
  });

  it("logs through the given logger, at the level asked for", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const live = options({ logger });
    live.log("warn", { detail: 1 }, "a warning");
    live.log("error", { detail: 2 }, "an error");
    expect(logger.warn).toHaveBeenCalledWith({ detail: 1 }, "a warning");
    expect(logger.error).toHaveBeenCalledWith({ detail: 2 }, "an error");
  });

  it("is off without a Google Cloud project", () => {
    expect(options().upstream).toBeNull();
  });
});
