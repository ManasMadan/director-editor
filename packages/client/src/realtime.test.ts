import { describe, expect, it, vi } from "vitest";
import { abortableSleep, withJitter } from "./realtime";

describe("waiting between reconnects", () => {
  it("leaves no listener behind on the signal, however many waits there are", async () => {
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");
    for (let i = 0; i < 20; i++) {
      await abortableSleep(1, signal);
    }
    expect(added).toHaveBeenCalledTimes(20);
    expect(removed).toHaveBeenCalledTimes(20);
  });

  it("ends at once when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = abortableSleep(60_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the wait before reconnecting", () => {
  it("is spread between half and all of the backoff, so tabs don't return together", () => {
    const waits = Array.from({ length: 200 }, () => withJitter(8_000));
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(4_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(8_000);
    expect(new Set(waits).size).toBeGreaterThan(100);
  });
});
