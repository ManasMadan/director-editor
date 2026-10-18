import { describe, expect, it } from "vitest";
import {
  countedMs,
  type FootageSlice,
  footageThrough,
  looksLikeRecording,
  recordingSliceKey,
} from "./recording";

/** Ten-second slices from the part's start, the given ones stored. */
function slices(count: number, uploaded = (_index: number) => true): FootageSlice[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: index * 10_000,
    durationMs: 10_000,
    uploaded: uploaded(index),
  }));
}

describe("the footage an attempt needs", () => {
  it("is every slice from the first to the one two seconds past its end", () => {
    // Ends at 25 s: the slice from 20 to 30 s covers 27 s.
    expect(footageThrough(slices(5), 25_000, null)).toBe(2);
    // Ends at 29 s: 31 s is in the next slice.
    expect(footageThrough(slices(5), 29_000, null)).toBe(3);
  });

  it("waits for a slice still to come, or one not stored yet", () => {
    expect(footageThrough(slices(2), 25_000, null)).toBeNull();
    expect(
      footageThrough(
        slices(5, (index) => index !== 1),
        25_000,
        null,
      ),
    ).toBeNull();
    // A gap: the second slice never signed.
    expect(
      footageThrough(
        slices(5).filter((slice) => slice.index !== 1),
        25_000,
        null,
      ),
    ).toBeNull();
  });

  it("is all of an ended part's footage when the attempt runs past it, or to its end", () => {
    expect(footageThrough(slices(3), 45_000, 3)).toBe(2);
    expect(footageThrough(slices(3), null, 3)).toBe(2);
    // Still recording: its end isn't known yet.
    expect(footageThrough(slices(3), null, null)).toBeNull();
    // Ended, but a slice is still on its way.
    expect(
      footageThrough(
        slices(3, (index) => index < 2),
        null,
        3,
      ),
    ).toBeNull();
  });

  it("is nothing for a part that ended without a slice", () => {
    expect(footageThrough([], null, 0)).toBeNull();
  });
});

describe("how long a slice counts for", () => {
  it("is its duration, or as long as its size takes at the highest bitrate a recorder reaches", () => {
    expect(countedMs({ durationMs: 10_000, size: 2_000_000 })).toBe(10_000);
    expect(countedMs({ durationMs: 1, size: 8_000_000 })).toBe(10_000);
    expect(countedMs({ durationMs: 1, size: 1 })).toBe(1);
  });
});

describe("a part's first bytes", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(
      values.flatMap((value) =>
        typeof value === "string" ? [...new TextEncoder().encode(value)] : [value],
      ),
    );

  it("start WebM with its EBML header and MP4 with an ftyp box", () => {
    expect(looksLikeRecording(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f), "video/webm")).toBe(true);
    expect(looksLikeRecording(bytes(0, 0, 0, 0x20, "ftypisom"), "video/mp4")).toBe(true);
  });

  it("are refused as anything else, or as the other type", () => {
    expect(looksLikeRecording(bytes("#EXTM3U\n"), "video/webm")).toBe(false);
    expect(looksLikeRecording(bytes("#EXTM3U\n"), "video/mp4")).toBe(false);
    expect(looksLikeRecording(bytes(0, 0, 0, 0x20, "ftypisom"), "video/webm")).toBe(false);
    expect(looksLikeRecording(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0), "video/mp4")).toBe(false);
    expect(looksLikeRecording(bytes(), "video/webm")).toBe(false);
  });
});

describe("a slice's key", () => {
  it("is under its session and part", () => {
    expect(recordingSliceKey("s", 2, 7)).toBe("recordings/s/2/7");
  });
});
