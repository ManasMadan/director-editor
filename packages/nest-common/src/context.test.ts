import { describe, expect, it } from "vitest";
import {
  contextLogFields,
  currentContext,
  jobMetaFromContext,
  runJob,
  runWithContext,
  updateContext,
} from "./context";

describe("request context", () => {
  it("is there for everything the call awaits, and gone outside it", async () => {
    await runWithContext({ requestId: "r-1", orgId: "o-1" }, async () => {
      // A real hop through the event loop, as an awaited I/O call takes.
      await new Promise((resolve) => setImmediate(resolve));
      expect(currentContext()).toEqual({ requestId: "r-1", orgId: "o-1" });
    });
    expect(currentContext()).toBeUndefined();
  });

  it("learns the user mid-request, and ignores updates outside a request", () => {
    updateContext({ userId: "nobody" });
    expect(currentContext()).toBeUndefined();
    runWithContext({ requestId: "r-2" }, () => {
      updateContext({ userId: "u-1" });
      expect(currentContext()).toEqual({ requestId: "r-2", userId: "u-1" });
    });
  });

  it("copies the request and user ids onto a job, and nothing outside a request", () => {
    expect(jobMetaFromContext()).toEqual({});
    runWithContext({ requestId: "r-4", orgId: "o-4", locale: "es" }, () => {
      updateContext({ userId: "u-4" });
      expect(jobMetaFromContext()).toEqual({ requestId: "r-4", userId: "u-4" });
    });
  });

  it("runs a job in the context it was queued from, named by the fallback when none", () => {
    expect(runJob({ requestId: "r-5", orgId: "o-5" }, "job:1", () => currentContext())).toEqual({
      requestId: "r-5",
      orgId: "o-5",
    });
    expect(runJob({}, "event:e-1", () => currentContext())).toEqual({ requestId: "event:e-1" });
  });

  it("puts only the ids it has on log lines, never personal data", () => {
    expect(contextLogFields()).toEqual({});
    runWithContext({ requestId: "r-3", locale: "es", timeZone: "Europe/Madrid" }, () => {
      expect(contextLogFields()).toEqual({ requestId: "r-3" });
    });
    runWithContext({ requestId: "r-4", userId: "u-1", orgId: "o-1", locale: "es" }, () => {
      expect(contextLogFields()).toEqual({ requestId: "r-4", userId: "u-1", orgId: "o-1" });
    });
  });
});
