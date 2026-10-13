import { REALTIME_REDIS_PREFIX } from "@repo/contracts/realtime";
import { REALTIME_CHANNEL_PREFIX } from "@repo/nest-common";
import { describe, expect, it } from "vitest";

describe("realtime channels", () => {
  it("are named the same by the Node hub and the Python publisher", () => {
    expect(REALTIME_CHANNEL_PREFIX).toBe(REALTIME_REDIS_PREFIX);
  });
});
