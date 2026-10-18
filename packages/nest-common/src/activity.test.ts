import { Writable } from "node:stream";
import { loggerOptions } from "@repo/logger";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { activityLine, logActivity, outcomeOf } from "./activity";
import { contextLogFields, runWithContext } from "./context";
import { AppError } from "./errors";

/** A real logger, configured as the services' are, writing its lines to an array. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(z.record(z.string(), z.unknown()).parse(JSON.parse(String(chunk))));
      done();
    },
  });
  const log = pino({ ...loggerOptions({ service: "test" }), mixin: contextLogFields }, sink);
  return { log, lines };
}

const request = {
  requestId: "r-1",
  userId: "u-1",
  orgId: "o-1",
  email: "ada@example.com",
  name: "Ada",
  demo: false,
  ip: "203.0.113.9",
  userAgent: "Mozilla/5.0",
};

describe("an activity line", () => {
  it("names who did it, from where and under which request, from the request's context", () => {
    const line = runWithContext(request, () =>
      activityLine({ activity: "director.take_recorded", target: { videoId: "v1" } }),
    );
    expect(line).toEqual({
      activity: "director.take_recorded",
      actor: { userId: "u-1", email: "ada@example.com", name: "Ada", demo: false },
      orgId: "o-1",
      target: { videoId: "v1" },
      outcome: "ok",
      reason: undefined,
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      requestId: "r-1",
      durationMs: undefined,
    });
  });

  it("takes the actor, workspace and request it's given where there is no request", () => {
    const line = activityLine({
      activity: "job.finished",
      actor: { userId: "u-2" },
      orgId: "o-2",
      requestId: "r-2",
      durationMs: 12.6,
      outcome: "failed",
      reason: "INTERNAL",
    });
    expect(line).toMatchObject({
      actor: { userId: "u-2" },
      orgId: "o-2",
      requestId: "r-2",
      durationMs: 13,
      outcome: "failed",
      reason: "INTERNAL",
    });
    expect(line.ip).toBeUndefined();
  });
});

describe("logging an activity", () => {
  it("writes one JSON line, with the request's ids beside the activity", () => {
    const { log, lines } = capture();
    runWithContext(request, () => logActivity(log, { activity: "auth.signed_out" }));
    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "activity",
        service: "test",
        activity: "auth.signed_out",
        actor: { userId: "u-1", email: "ada@example.com", name: "Ada", demo: false },
        requestId: "r-1",
        userId: "u-1",
        orgId: "o-1",
        outcome: "ok",
      }),
    ]);
  });

  it("writes a failure at warn and a refusal at info", () => {
    const { log, lines } = capture();
    logActivity(log, { activity: "director.published", outcome: "failed", reason: "INTERNAL" });
    logActivity(log, { activity: "director.published", outcome: "refused", reason: "CONFLICT" });
    expect(lines.map((line) => line.level)).toEqual(["warn", "info"]);
  });
});

describe("the outcome of an error", () => {
  it("is refused for a client's error and failed for ours, with its code", () => {
    expect(outcomeOf(new AppError("PUBLISH_DEMO_DISABLED"))).toEqual({
      outcome: "refused",
      reason: "PUBLISH_DEMO_DISABLED",
    });
    // The oRPC error an AppError becomes carries the same code.
    expect(outcomeOf({ code: "UPSTREAM_UNAVAILABLE", status: 502 })).toEqual({
      outcome: "failed",
      reason: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("is failed, as INTERNAL, for anything without a code of the catalog", () => {
    expect(outcomeOf(new Error("boom"))).toEqual({ outcome: "failed", reason: "INTERNAL" });
    expect(outcomeOf({ code: "SOMETHING_ELSE" })).toEqual({
      outcome: "failed",
      reason: "INTERNAL",
    });
  });
});
