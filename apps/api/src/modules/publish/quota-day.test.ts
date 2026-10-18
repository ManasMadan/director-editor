/** YouTube's quota day: a calendar day in Pacific time, daylight saving included. */
import { describe, expect, it } from "vitest";
import { nextQuotaDay, quotaDay } from "./quota-day";

const at = (iso: string) => new Date(iso);
const seconds = (iso: string) => Date.parse(iso) / 1000;

describe("YouTube's quota day", () => {
  it("is the date in Pacific time, not in UTC", () => {
    // 05:00 UTC on the 18th is still the 17th in California.
    expect(quotaDay(at("2026-10-18T05:00:00Z"))).toBe("2026-10-17");
    expect(quotaDay(at("2026-10-18T07:00:00Z"))).toBe("2026-10-18");
  });

  it("ends at the next midnight in Pacific time, across daylight saving's start", () => {
    // Saturday 7 March 2026, 23:30 PST: the next day starts at 00:00 PST, still winter time.
    expect(quotaDay(at("2026-03-08T07:30:00Z"))).toBe("2026-03-07");
    expect(nextQuotaDay(at("2026-03-08T07:30:00Z"))).toBe(seconds("2026-03-08T08:00:00Z"));
    // Sunday 8 March, 05:00 PDT (clocks went forward at 02:00): Monday starts at 00:00 PDT.
    expect(quotaDay(at("2026-03-08T12:00:00Z"))).toBe("2026-03-08");
    expect(nextQuotaDay(at("2026-03-08T12:00:00Z"))).toBe(seconds("2026-03-09T07:00:00Z"));
  });

  it("ends at the next midnight in Pacific time, across daylight saving's end", () => {
    // Saturday 31 October 2026, 23:30 PDT: Sunday starts at 00:00 PDT.
    expect(quotaDay(at("2026-11-01T06:30:00Z"))).toBe("2026-10-31");
    expect(nextQuotaDay(at("2026-11-01T06:30:00Z"))).toBe(seconds("2026-11-01T07:00:00Z"));
    // Sunday 1 November, 04:00 PST (clocks went back at 02:00): a 25-hour day, Monday at 00:00 PST.
    expect(nextQuotaDay(at("2026-11-01T12:00:00Z"))).toBe(seconds("2026-11-02T08:00:00Z"));
  });

  it("ends at a later midnight on the last day of a year", () => {
    expect(quotaDay(at("2026-12-31T20:00:00Z"))).toBe("2026-12-31");
    expect(nextQuotaDay(at("2026-12-31T20:00:00Z"))).toBe(seconds("2027-01-01T08:00:00Z"));
  });
});
