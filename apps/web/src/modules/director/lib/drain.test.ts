import { describe, expect, it } from "vitest";
import { caughtUp, STALL_MS, type Written } from "./drain";

const FRAME = 1 / 30;
/** A 12.2-second video, as the harness rendered it in Chrome on a machine under load. */
const EXPECTED = 12.2;

/** The checks of a wait, every half second, the picture as `at` (ms) says it was then. */
function checks(until: number, picture: (at: number) => number): Written[] {
  const all: Written[] = [];
  for (let at = 500; at <= until; at += 500) {
    all.push({ at, picture: picture(at) });
  }
  return all;
}

describe("waiting for the recorder's encoder after the last frame", () => {
  it("stops at once when the whole picture is written", () => {
    expect(caughtUp([{ at: 500, picture: EXPECTED - FRAME / 2 }], EXPECTED, FRAME)).toBe(true);
    expect(caughtUp([], EXPECTED, FRAME)).toBe(false);
  });

  it("stops a few seconds on when only the last piece is left and nothing moves", () => {
    // Caught up already: the last MP4 fragment is written when the recorder stops.
    const idle = (until: number) => checks(until, () => 10.06);
    expect(caughtUp(idle(STALL_MS), EXPECTED, FRAME)).toBe(false);
    expect(caughtUp(idle(STALL_MS + 500), EXPECTED, FRAME)).toBe(true);
  });

  it("keeps waiting while the encoder is behind, at the pace it keeps", () => {
    // What Chrome wrote, fragment by fragment, after a render under a load average of 37.
    const behind = (at: number) => {
      if (at < 9630) {
        return 0;
      }
      if (at < 17450) {
        return 3.33;
      }
      return at < 25081 ? 6.69 : 10.06;
    };
    // Far from done: no stopping, however long it's still.
    expect(caughtUp(checks(9500, behind), EXPECTED, FRAME)).toBe(false);
    expect(caughtUp(checks(24_000, behind), EXPECTED, FRAME)).toBe(false);
    // The last fragment is left: at 0.44 s of picture a second, 2.1 s more takes 4.9 s.
    expect(caughtUp(checks(29_000, behind), EXPECTED, FRAME)).toBe(false);
    expect(caughtUp(checks(30_500, behind), EXPECTED, FRAME)).toBe(true);
  });

  it("takes a longer piece than usual as the last one left", () => {
    // Fragments of 5 s: 7.5 s written of 12.2 is one fragment short.
    const long = (at: number) => (at < 4000 ? 2.5 : 7.5);
    expect(caughtUp(checks(4000 + STALL_MS + 2000, long), EXPECTED, FRAME)).toBe(true);
    // A first piece that's most of the video says nothing about how long pieces are.
    expect(
      caughtUp(
        checks(STALL_MS + 500, () => 6),
        EXPECTED,
        FRAME,
      ),
    ).toBe(false);
  });
});
