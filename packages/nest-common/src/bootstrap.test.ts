import { describe, expect, it } from "vitest";
import { maxHeapBytes } from "./bootstrap";

describe("the heap a service sheds load at", () => {
  it("is 90% of the container's memory limit, or of 2 GB without one", () => {
    const gigabytes = (count: number) => count * 1024 ** 3;
    expect(maxHeapBytes(1000, gigabytes(8))).toBe(900);
    expect(maxHeapBytes(0, gigabytes(8))).toBe(0.9 * gigabytes(2));
    // Linux reports an unlimited cgroup as about 2^64, more than any machine has.
    expect(maxHeapBytes(2 ** 64, gigabytes(8))).toBe(0.9 * gigabytes(2));
    // Whatever this machine reports, a number the shedding can compare against.
    expect(maxHeapBytes()).toBeGreaterThan(0);
  });
});
