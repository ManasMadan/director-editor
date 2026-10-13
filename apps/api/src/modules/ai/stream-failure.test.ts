import { AiServiceError } from "@repo/ai-client";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { streamFailureLevel } from "./ai.service";

describe("an assistant answer that breaks off", () => {
  it("is a warning when the service or the connection failed", () => {
    expect(streamFailureLevel(new AiServiceError(503, "UPSTREAM_UNAVAILABLE"))).toBe("warn");
    expect(streamFailureLevel(new TypeError("terminated"))).toBe("warn");
  });

  it("is an error for anything else: the stream breaking its contract is a bug", () => {
    const drift = z.object({ type: z.literal("token") }).safeParse({ type: "tokn" });
    expect(streamFailureLevel(drift.error)).toBe("error");
    expect(streamFailureLevel(new TypeError("Cannot read properties of undefined"))).toBe("error");
  });
});
