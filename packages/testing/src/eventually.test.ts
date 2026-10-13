import { describe, expect, it } from "vitest";
import { eventually } from "./eventually";

describe("eventually", () => {
  it("reads until the value is done, and returns it", async () => {
    let reads = 0;
    expect(
      await eventually(
        async () => ++reads,
        (n) => n === 3,
        { interval: 1 },
      ),
    ).toBe(3);
    expect(reads).toBe(3);
  });

  it("fails with the last value once the time is up", async () => {
    await expect(
      eventually(
        () => ({ state: "waiting" }),
        () => false,
        { timeout: 20 },
      ),
    ).rejects.toThrow("still waiting, last read: { state: 'waiting' }");
  });
});
