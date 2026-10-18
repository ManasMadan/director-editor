import { describe, expect, it } from "vitest";
import { EMPTY_VERSION, films, nearestFilmed, nextFilmed } from "./your-version";

describe("the shots a member films", () => {
  const version = { ...EMPTY_VERSION, skipped: [1], gaps: [2, 4] };

  it("leave out skipped shots and gaps", () => {
    expect(films(version, 0)).toBe(true);
    expect(films(version, 1)).toBe(false);
    expect(nextFilmed(version, 0, 5)).toBe(3);
    expect(nextFilmed(version, 3, 5)).toBeNull();
  });

  it("find the nearest one: itself, the next filmed, else the one before", () => {
    expect(nearestFilmed(version, 3, 5)).toBe(3);
    expect(nearestFilmed(version, 1, 5)).toBe(3);
    expect(nearestFilmed(version, 4, 5)).toBe(3);
    expect(nearestFilmed({ ...EMPTY_VERSION, gaps: [0, 1] }, 1, 2)).toBeNull();
  });
});
