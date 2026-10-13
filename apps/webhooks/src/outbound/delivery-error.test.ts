import { AppError } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { deliveryError } from "./delivery.service";

describe("why a delivery attempt failed", () => {
  it("is a code for what the endpoint caused", () => {
    expect(deliveryError(new AppError("DESTINATION_NOT_ALLOWED"))).toBe("destination_not_allowed");
    expect(deliveryError(new AppError("RESPONSE_TOO_LARGE"))).toBe("response_too_large");
    expect(deliveryError(new DOMException("timed out", "TimeoutError"))).toBe("timeout");
    expect(deliveryError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBe(
      "connection_failed",
    );
  });

  it("rethrows anything else: it's our bug, not the endpoint's", () => {
    const bug = new TypeError("Cannot read properties of undefined");
    expect(() => deliveryError(bug)).toThrow(bug);
    expect(() => deliveryError(new AppError("INTERNAL"))).toThrow(AppError);
  });
});
