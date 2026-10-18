import { describe, expect, it } from "vitest";
import { columnWidth, timecode } from "./track";

describe("the editor's board", () => {
  it("reads the clock as minutes and seconds", () => {
    expect(timecode(0)).toBe("00:00");
    expect(timecode(9.99)).toBe("00:09");
    expect(timecode(3)).toBe("00:03");
    expect(timecode(75)).toBe("01:15");
    expect(timecode(-2)).toBe("00:00");
  });

  it("makes a shot's column as wide as it is long, within bounds", () => {
    expect(columnWidth(3)).toBe(192);
    expect(columnWidth(4.5)).toBe(288);
    // From about two seconds up a column grows with its shot; shorter ones stay tappable.
    expect(columnWidth(2)).toBe(128);
    expect(columnWidth(1.5)).toBe(120);
    expect(columnWidth(0.5)).toBe(120);
    expect(columnWidth(30)).toBe(360);
  });
});
