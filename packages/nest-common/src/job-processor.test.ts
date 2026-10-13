/**
 * What a failure looks like in the logs, for the cases a real queue rarely produces (the
 * common ones run against Valkey in test/job-processor.integration.test.ts).
 */
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asError, describeError, JobProcessor } from "./job-processor";

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

  it("logs the worker's own errors", () => {
    new Processor().onWorkerError(new Error("connection lost"));
    expect(logged).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "connection lost" }) },
      "queue worker error",
    );
  });
});
