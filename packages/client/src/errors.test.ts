import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { errorCode, errorMessageKey, errorParams, errorRequestId, fieldErrors } from "./errors";

const validation = new ORPCError("VALIDATION_FAILED", {
  data: {
    params: {},
    requestId: "req-1",
    issues: [
      { path: ["title"], code: "too_small" },
      { path: ["items", 0, "name"], code: "required" },
    ],
  },
});

describe("errorCode", () => {
  it("is the API's code, unreachable for a network failure, internal otherwise", () => {
    expect(errorCode(validation)).toBe("VALIDATION_FAILED");
    expect(errorMessageKey(new ORPCError("TODO_NOT_FOUND"))).toBe("errors.TODO_NOT_FOUND");
    expect(errorCode(new TypeError("Failed to fetch"))).toBe("SERVICE_UNAVAILABLE");
    // A code the contract doesn't know (a newer API) is shown as a generic failure.
    expect(errorCode(new ORPCError("SOMETHING_NEW"))).toBe("INTERNAL");
    expect(errorCode(new Error("boom"))).toBe("INTERNAL");
  });

  it("reads a code the API reported inside a response, as { code }", () => {
    expect(errorMessageKey({ code: "AI_RUN_LIMIT" })).toBe("errors.AI_RUN_LIMIT");
    expect(errorCode({ code: "SOMETHING_NEW" })).toBe("INTERNAL");
    expect(errorCode(null)).toBe("INTERNAL");
  });
});

describe("what an error carries", () => {
  it("gives its params, request id and per-field problems", () => {
    const limited = new ORPCError("RATE_LIMITED", { data: { params: { seconds: 30 } } });
    expect(errorParams(limited)).toEqual({ seconds: 30 });
    expect(errorRequestId(validation)).toBe("req-1");
    expect(fieldErrors(validation)).toEqual({ title: "too_small", "items.0.name": "required" });
  });

  it("gives nothing for an error that carries nothing", () => {
    const bare = new ORPCError("VALIDATION_FAILED");
    expect(errorParams(bare)).toEqual({});
    expect(errorRequestId(bare)).toBeUndefined();
    expect(fieldErrors(bare)).toEqual({});
    expect(fieldErrors(new ORPCError("FORBIDDEN", { data: validation.data }))).toEqual({});
    const other = new Error("boom");
    expect(errorParams(other)).toEqual({});
    expect(errorRequestId(other)).toBeUndefined();
    expect(fieldErrors(other)).toEqual({});
  });

  it("ignores data that isn't in the contract's shape, from a newer or broken server", () => {
    const odd = new ORPCError("RATE_LIMITED", { data: { params: "30 seconds", requestId: 7 } });
    expect(errorParams(odd)).toEqual({});
    expect(errorRequestId(odd)).toBeUndefined();
  });
});
