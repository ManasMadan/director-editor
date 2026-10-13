import { describe, expect, it } from "vitest";
import { quietDelayMs } from "./quiet-hours";

const at = (iso: string) => new Date(iso);
const night = { start: 22 * 60, end: 7 * 60 };

describe("quietDelayMs", () => {
  it("waits until the end of a window that crosses midnight", () => {
    expect(quietDelayMs(night, "UTC", at("2026-09-29T23:30:00Z"))).toBe(7.5 * 3_600_000);
    expect(quietDelayMs(night, "UTC", at("2026-09-29T06:59:00Z"))).toBe(60_000);
  });

  it("sends right away outside the window, and when there's none", () => {
    expect(quietDelayMs(night, "UTC", at("2026-09-29T12:00:00Z"))).toBe(0);
    expect(quietDelayMs(night, "UTC", at("2026-09-29T07:00:00Z"))).toBe(0);
    expect(quietDelayMs(null, "UTC", at("2026-09-29T23:30:00Z"))).toBe(0);
  });

  it("uses the user's time zone", () => {
    // 23:30 UTC is 08:30 in Tokyo: not quiet there.
    expect(quietDelayMs(night, "Asia/Tokyo", at("2026-09-29T23:30:00Z"))).toBe(0);
    // 13:30 UTC is 22:30 in Tokyo: quiet for 8.5 hours.
    expect(quietDelayMs(night, "Asia/Tokyo", at("2026-09-29T13:30:00Z"))).toBe(8.5 * 3_600_000);
  });

  it("reads a zone it doesn't know as UTC instead of failing the delivery", () => {
    expect(quietDelayMs(night, "Not/AZone", at("2026-09-29T23:30:00Z"))).toBe(7.5 * 3_600_000);
  });

  it("handles a same-day window", () => {
    const lunch = { start: 12 * 60, end: 13 * 60 };
    expect(quietDelayMs(lunch, "UTC", at("2026-09-29T12:15:00Z"))).toBe(45 * 60_000);
  });
});
