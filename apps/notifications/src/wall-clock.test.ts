import { describe, expect, it } from "vitest";
import { wallClock } from "./wall-clock";

describe("wallClock", () => {
  const at = new Date("2026-03-01T23:30:15Z");

  it("gives the time and date in the zone, across the date line", () => {
    expect(wallClock("UTC", at)).toEqual({ hour: 23, minute: 30, second: 15, date: "2026-03-01" });
    expect(wallClock("Asia/Tokyo", at)).toMatchObject({ hour: 8, date: "2026-03-02" });
    expect(wallClock("America/Los_Angeles", at)).toMatchObject({ hour: 15, date: "2026-03-01" });
    expect(wallClock("Asia/Kolkata", at)).toMatchObject({ hour: 5, minute: 0, date: "2026-03-02" });
  });

  it.each(["Mars/Olympus", "", null, undefined])("reads %j as UTC instead of throwing", (zone) => {
    expect(wallClock(zone, at)).toEqual(wallClock("UTC", at));
  });
});
