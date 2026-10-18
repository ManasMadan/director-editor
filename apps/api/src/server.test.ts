/**
 * The live call's wiring (liveCallOptions), directly: the call itself is unit-tested
 * against a stand-in Live API (src/modules/live/live.test.ts), and who may start one
 * through the real server in apps/api/test/director.integration.test.ts. Neither gets
 * as far as spendCallLimit or recordCallStarted (both need a real Gemini connection), so
 * this is where those two closures are proven to delegate to the right thing.
 */
import type { IncomingMessage } from "node:http";
import { directorTakeSchema } from "@repo/contracts/api";
import { orgIdSchema, userIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { liveCallOptions } from "./server";

const userId = userIdSchema.parse("5e2d7c3a-1b4f-4a8e-9c6d-7f0a2b3c4d5e");
const orgId = orgIdSchema.parse("0b9f5c1e-3f4a-4c55-8f0e-2a6d1c7e9b10");
const videoId = videoIdSchema.parse("dQw4w9WgXcQ");
const caller = {
  orgId,
  userId,
  role: "member" as const,
  signedInAt: new Date(0),
  demo: false,
  guest: false,
  sharedDemo: false,
};

const notNeeded = vi.fn(() => Promise.reject(new Error("not needed")));

function options(overrides: Partial<Parameters<typeof liveCallOptions>[0]> = {}) {
  return liveCallOptions({
    caller: () => Promise.resolve(caller),
    director: { planOf: notNeeded, takes: notNeeded, chooseTake: notNeeded },
    analytics: { record: vi.fn() },
    calls: { take: vi.fn(() => Promise.resolve()) },
    guestCalls: { take: vi.fn(() => Promise.resolve()) },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    activity: vi.fn(),
    ...overrides,
  });
}

describe("the live call's wiring", () => {
  it("asks the director service for the caller's plan in their workspace, without its media", async () => {
    const planOf = vi.fn(() => Promise.reject(new Error("not needed")));
    const live = options({ director: { planOf, takes: notNeeded, chooseTake: notNeeded } });
    await expect(live.plan(caller, videoId)).rejects.toThrow("not needed");
    expect(planOf).toHaveBeenCalledWith(userId, orgId, videoId);
  });

  it("makes the member's pick the take of this shoot they named, by its number in the shot", async () => {
    const since = new Date(10_000);
    const of = (n: number, shotIndex: number, at: number) =>
      directorTakeSchema.parse({
        id: `0b9f5c1e-3f4a-4c55-8f0e-2a6d1c7e9b${String(n).padStart(2, "0")}`,
        shotIndex,
        fileId: "0b9f5c1e-3f4a-4c55-8f0e-2a6d1c7e9b99",
        kind: "video",
        status: "ready",
        error: null,
        bestStartMs: null,
        bestEndMs: null,
        score: null,
        feedback: null,
        reason: null,
        chosen: false,
        origin: "shoot",
        createdAt: new Date(at),
      });
    // Newest first, as the API lists them: one from an earlier shoot, one of another shot.
    const takes = [of(4, 0, 13_000), of(3, 1, 12_500), of(2, 0, 12_000), of(1, 0, 9_000)];
    const chooseTake = vi.fn(() => Promise.resolve([]));
    const live = options({
      director: { planOf: notNeeded, takes: vi.fn(() => Promise.resolve(takes)), chooseTake },
    });
    const picks = live.picks(caller, videoId, since);
    await expect(picks.choose(0, 2)).resolves.toBe("done");
    expect(chooseTake).toHaveBeenCalledWith(userId, orgId, {
      videoId,
      shotIndex: 0,
      takeId: takes[0]?.id,
    });
    await expect(picks.choose(0, 3)).resolves.toBe("not_found");
    expect(chooseTake).toHaveBeenCalledTimes(1);
  });

  it("spends the caller's call against the rate limiter, a demo guest's against its own", async () => {
    const [take, takeGuest] = [vi.fn(() => Promise.resolve()), vi.fn(() => Promise.resolve())];
    const live = options({ calls: { take }, guestCalls: { take: takeGuest } });
    await live.spendCallLimit({ userId, guest: false });
    expect(take).toHaveBeenCalledWith(userId);
    expect(takeGuest).not.toHaveBeenCalled();
    await live.spendCallLimit({ userId, guest: true });
    expect(takeGuest).toHaveBeenCalledWith(userId);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("records a started call and each of its turns as analytics events", () => {
    const record = vi.fn();
    const live = options({ analytics: { record } });
    live.recordCallStarted(userId, videoId);
    expect(record).toHaveBeenCalledWith("call_started", { userId, videoId });
    live.recordTurn({
      userId,
      videoId,
      template: "GRWM",
      shot: 2,
      input: "voice",
      latencyMs: 900,
      tools: ["mark"],
      interrupted: false,
      spoke: true,
      voiceMs: 2400,
      captionLagMs: 350,
    });
    expect(record).toHaveBeenCalledWith("director_turn", {
      userId,
      videoId,
      templateId: "GRWM",
      detail: {
        line: "live",
        shot: 2,
        input: "voice",
        latencyMs: 900,
        tools: ["mark"],
        interrupted: false,
        spoke: true,
        voiceMs: 2400,
        captionLagMs: 350,
      },
    });
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
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const live = options({ logger });
    live.log("warn", { detail: 1 }, "a warning");
    live.log("error", { detail: 2 }, "an error");
    live.log("info", { detail: 3 }, "a tool call");
    expect(logger.warn).toHaveBeenCalledWith({ detail: 1 }, "a warning");
    expect(logger.error).toHaveBeenCalledWith({ detail: 2 }, "an error");
    expect(logger.log).toHaveBeenCalledWith({ detail: 3 }, "a tool call");
  });

  it("is off without a Google Cloud project", () => {
    expect(options().upstream).toBeNull();
  });

  it("keeps Live on for everyone while LIVE_OFF_USERS is empty", () => {
    expect(options().liveOff(userId)).toBe(false);
  });
});
