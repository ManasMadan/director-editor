import { userIdSchema, videoIdSchema } from "@repo/contracts/ids";
import type { Analytics } from "@repo/nest-common";
import { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_KINDS, AnalyticsService } from "./analytics.service";

const userId = userIdSchema.parse("5e2d7c3a-1b4f-4a8e-9c6d-7f0a2b3c4d5e");
const videoId = videoIdSchema.parse("dQw4w9WgXcQ");

/** A real logger, silenced, so a test can spy on what it was asked to log. */
function logger() {
  return new PinoLogger({ pinoHttp: { level: "silent" } });
}

describe("recording a product analytics event", () => {
  it("does nothing when analytics is off, and never touches the logger", () => {
    const log = logger();
    const warn = vi.spyOn(log, "warn");
    const service = new AnalyticsService(null, log);
    expect(() => service.record("call_started", { userId })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the kind and fields straight through, without waiting for the write", async () => {
    const written = Promise.withResolvers<void>();
    const analytics: Analytics = { record: vi.fn(() => written.promise) };
    const log = logger();
    const warn = vi.spyOn(log, "warn");
    const service = new AnalyticsService(analytics, log);
    service.record("take_reviewed", { userId, videoId, score: 80 });
    // record() returned already: the write hasn't resolved yet.
    expect(analytics.record).toHaveBeenCalledWith({
      kind: "take_reviewed",
      userId,
      videoId,
      score: 80,
    });
    written.resolve();
    await vi.waitFor(() => expect(warn).not.toHaveBeenCalled());
  });

  it("defaults to no extra fields", () => {
    const analytics: Analytics = { record: vi.fn(() => Promise.resolve()) };
    new AnalyticsService(analytics, logger()).record("indexed");
    expect(analytics.record).toHaveBeenCalledWith({ kind: "indexed" });
  });

  it.each(ANALYTICS_KINDS)(
    "accepts the %s kind, including the ones no call site uses yet",
    (kind) => {
      const analytics: Analytics = { record: vi.fn(() => Promise.resolve()) };
      new AnalyticsService(analytics, logger()).record(kind);
      expect(analytics.record).toHaveBeenCalledWith({ kind });
    },
  );

  it("logs a failed write with its kind, instead of swallowing or throwing it", async () => {
    const failure = new Error("insert refused");
    const analytics: Analytics = { record: vi.fn(() => Promise.reject(failure)) };
    const log = logger();
    const warn = vi.spyOn(log, "warn");
    const service = new AnalyticsService(analytics, log);
    expect(() => service.record("published", { videoId })).not.toThrow();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "published" }),
        "failed to record an analytics event",
      ),
    );
  });
});
