import { describe, expect, it } from "vitest";
import { peaks, rulerTicks, timecode } from "./track";

describe("the timeline", () => {
  it("reads the clock as minutes and seconds", () => {
    expect(timecode(0)).toBe("00:00");
    expect(timecode(9.99)).toBe("00:09");
    expect(timecode(3)).toBe("00:03");
    expect(timecode(75)).toBe("01:15");
    expect(timecode(-2)).toBe("00:00");
  });

  it("ticks every half second, labelling whole ones, to the next whole second", () => {
    expect(rulerTicks(1.2)).toEqual([
      { seconds: 0, label: true },
      { seconds: 0.5, label: false },
      { seconds: 1, label: true },
      { seconds: 1.5, label: false },
      { seconds: 2, label: true },
    ]);
    expect(rulerTicks(0)).toEqual([{ seconds: 0, label: true }]);
  });

  it("turns a take's sound into bars against its loudest", () => {
    const samples = new Float32Array([0, 0.1, -0.5, 0.25, 0, 0, 0.2, -0.1]);
    const bars = peaks(samples, 4, 0, 2, 4);
    expect(bars.map((bar) => Math.round(bar * 100) / 100)).toEqual([0.2, 1, 0, 0.4]);
    expect(peaks(samples, 4, 1, 2, 2)).toEqual([0, 1]);
    expect(peaks(new Float32Array(8), 4, 0, 2, 2)).toEqual([0, 0]);
    expect(peaks(samples, 4, 0, 2, 0)).toEqual([]);
  });

  it("reads a sample the buffer doesn't hold as silence", () => {
    // A buffer that claims more samples than it has.
    const short = new Float32Array([0.5, -1]);
    const claimed = new Proxy(short, {
      get: (target, key) => (key === "length" ? 4 : Reflect.get(target, key)),
    });
    expect(peaks(claimed, 4, 0, 1, 2)).toEqual([1, 0]);
  });
});
