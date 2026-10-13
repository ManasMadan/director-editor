import { describe, expect, it } from "vitest";
import { directorsCut, type Sample, type Setup } from "./cut";

/** A take of `seconds`, sampled four times a second, shaped by `at`. */
function take(seconds: number, at: (time: number) => Partial<Sample> = () => ({})): Sample[] {
  return Array.from({ length: seconds * 4 + 1 }, (_, index) => {
    const time = index / 4;
    return { seconds: time, motion: 0.01, light: "good", loudness: 0.08, ...at(time) };
  });
}

const video: Setup = { kind: "video", length: 3, framed: true, angled: true, posed: true };

describe("the Director's Cut", () => {
  it("loops the steadiest stretch of the shot's length", () => {
    // Shaky while getting set, steady from two seconds in.
    const cut = directorsCut(
      take(5.5, (time) => ({ motion: time < 2 ? 0.12 : 0.01 })),
      video,
    );
    expect(cut.startSeconds).toBe(2);
    expect(cut.endSeconds).toBe(5);
    expect(cut.lateStart).toBe(true);
  });

  it("praises what went best and has nothing to fix in a clean take", () => {
    const cut = directorsCut(take(4), video);
    expect(cut.startSeconds).toBe(0);
    expect(cut.lateStart).toBe(false);
    expect(cut.praise).toBe("framing");
    expect(cut.tip).toBeNull();
    expect(cut.score).toBeGreaterThan(90);
  });

  it("asks for the most important fix first", () => {
    const loose = { ...video, framed: false, angled: false, posed: false };
    expect(directorsCut(take(1.5), loose).tip).toBe("longer");
    expect(
      directorsCut(
        take(4, () => ({ light: "too-dark" })),
        loose,
      ).tip,
    ).toBe("too-dark");
    expect(
      directorsCut(
        take(4, () => ({ motion: 0.2 })),
        loose,
      ).tip,
    ).toBe("steady");
    expect(directorsCut(take(4), loose).tip).toBe("framing");
    expect(
      directorsCut(
        take(4, () => ({ loudness: 0.01 })),
        { ...loose, framed: null },
      ).tip,
    ).toBe("energy");
    expect(directorsCut(take(4), { ...loose, framed: null }).tip).toBe("angle");
    expect(directorsCut(take(4), { ...loose, framed: null, angled: null }).tip).toBe("pose");
  });

  it("scores a rough take lower, but never below a floor", () => {
    const rough = directorsCut(
      take(1, () => ({ motion: 0.3, light: "backlit", loudness: 0.001 })),
      { ...video, framed: false, angled: false, posed: false },
    );
    expect(rough.score).toBe(35);
    expect(rough.praise).toBe("effort");
  });

  it("praises the next best thing when framing isn't judged", () => {
    const unjudged = { ...video, framed: null };
    expect(directorsCut(take(4), unjudged).praise).toBe("steady");
    const shaky = (light: Sample["light"], loudness: number | null) =>
      take(4, () => ({ motion: 0.06, light, loudness }));
    expect(directorsCut(shaky("good", 0.08), unjudged).praise).toBe("light");
    expect(directorsCut(shaky("too-bright", 0.08), unjudged).praise).toBe("energy");
    expect(directorsCut(shaky("too-bright", 0.01), unjudged).praise).toBe("pose");
    expect(directorsCut(shaky("too-bright", null), unjudged).praise).toBe("energy");
  });

  it("judges a photo by its setup alone", () => {
    const cut = directorsCut([], {
      kind: "photo",
      length: 2,
      framed: true,
      angled: null,
      posed: null,
    });
    expect(cut).toEqual({
      startSeconds: 0,
      endSeconds: 2,
      score: 97,
      praise: "framing",
      tip: null,
      lateStart: false,
    });
  });
});
