/**
 * What a failure looks like in the logs, for the cases a real queue rarely produces (the
 * common ones run against Valkey in test/job-processor.integration.test.ts).
 */
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asError, describeError, JobProcessor, jobActivity } from "./job-processor";

class Processor extends JobProcessor {
  async process() {
    return undefined;
  }
}
const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
afterEach(() => logged.mockClear());

describe("asError", () => {
  it("keeps an Error, and wraps anything else thrown", () => {
    const error = new TypeError("boom");
    expect(asError(error)).toBe(error);
    expect(asError("plain string").message).toBe("plain string");
  });
});

describe("describeError", () => {
  it("describes anything thrown, and at most three causes deep", () => {
    expect(describeError("plain string")).toEqual({ message: "plain string" });
    let error = new Error("0");
    for (let depth = 1; depth <= 5; depth++) {
      error = new Error(String(depth), { cause: error });
    }
    const described = describeError(error);
    expect(described).toMatchObject({
      type: "Error",
      message: "5",
      cause: { message: "4", cause: { message: "3", cause: { message: "2" } } },
    });
    expect(JSON.stringify(described)).not.toContain('"message":"1"');
  });
});

describe("JobProcessor", () => {
  it("logs a failure BullMQ reports without its job as final", () => {
    new Processor().onJobFailed(undefined, new Error("lost the lock"));
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: undefined, attempts: 1, final: true }),
      "job failed for good",
    );
  });

  it("writes no activity line for a failure BullMQ reports without its job", () => {
    const warned = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    new Processor().onJobFailed(undefined, new Error("lost the lock"));
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it("logs the worker's own errors", () => {
    new Processor().onWorkerError(new Error("connection lost"));
    expect(logged).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "connection lost" }) },
      "queue worker error",
    );
  });
});

describe("a job's activity line", () => {
  const job = {
    queueName: "events-audit",
    name: "event",
    id: "e-1",
    attemptsMade: 1,
    processedOn: 1_000,
    finishedOn: 1_250,
    data: {
      meta: { requestId: "r-1", userId: "u-1", orgId: "o-1" },
      payload: { name: "auth.session_started.v1" },
    },
  };

  it("names the user, workspace and request it ran for, and its event", () => {
    expect(jobActivity(job, { outcome: "ok" })).toEqual({
      activity: "job.finished",
      outcome: "ok",
      reason: undefined,
      actor: { userId: "u-1" },
      orgId: "o-1",
      requestId: "r-1",
      target: {
        queue: "events-audit",
        job: "event",
        jobId: "e-1",
        attempt: 1,
        event: "auth.session_started.v1",
      },
      durationMs: 250,
    });
  });

  it("reads nothing it can't trust from a job without meta, or not yet finished", () => {
    const bare = { ...job, id: undefined, data: { meta: { userId: 7 } }, finishedOn: undefined };
    expect(jobActivity(bare, { outcome: "failed", reason: "Error" })).toMatchObject({
      actor: { userId: undefined },
      orgId: undefined,
      requestId: undefined,
      target: { queue: "events-audit", job: "event", jobId: null, attempt: 1 },
      durationMs: undefined,
    });
  });
});
