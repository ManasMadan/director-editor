import { describe, expect, it } from "vitest";
import {
  globalShift,
  labelSide,
  luminance,
  MARK_FADE_MS,
  MARK_LIFETIME_MS,
  MarkBoard,
  minus,
  moved,
  plus,
  RELOCATES_PER_SHOT,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  toScreen,
  visibleShare,
} from "./marks";

const box = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

describe("a mark on screen", () => {
  it("lands where the frame Gemini saw is shown, on a phone's own 9:16 picture", () => {
    expect(toScreen(box, { width: 720, height: 1280 }, { width: 360, height: 640 }, false)).toEqual(
      { left: 90, top: 320, width: 180, height: 160 },
    );
  });

  it("follows object-cover's crop of a picture taller than the camera's frame", () => {
    // A 390×844 phone screen showing a 720×1280 camera: the sides are cropped off.
    const rect = toScreen(box, { width: 720, height: 1280 }, { width: 390, height: 844 }, false);
    const scale = 844 / 1280;
    const offset = (720 * scale - 390) / 2;
    expect(rect.left).toBeCloseTo(180 * scale - offset);
    expect(rect.top).toBeCloseTo(640 * scale);
    expect(rect.width).toBeCloseTo(360 * scale);
  });

  it("maps a laptop's wide frame through the 9:16 crop Gemini was sent", () => {
    // 1280×720: the viewfinder is the middle 405×720; the element shows it exactly.
    const rect = toScreen(
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 1280, height: 720 },
      { width: 405, height: 720 },
      false,
    );
    expect(rect.left).toBeCloseTo(0);
    expect(rect.width).toBeCloseTo(405);
    expect(rect.height).toBeCloseTo(720);
  });

  it("is mirrored on the front camera's mirrored preview", () => {
    const left = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    const rect = toScreen(left, { width: 720, height: 1280 }, { width: 360, height: 640 }, true);
    // The thing on the frame's left shows on the screen's right.
    expect(rect.left).toBeCloseTo(360 - 36 - 72);
    expect(rect.width).toBeCloseTo(72);
  });

  it("counts how much of it is in the picture", () => {
    const element = { width: 100, height: 100 };
    expect(visibleShare({ left: 0, top: 0, width: 50, height: 50 }, element)).toBe(1);
    expect(visibleShare({ left: 75, top: 0, width: 50, height: 50 }, element)).toBe(0.5);
    expect(visibleShare({ left: 120, top: 0, width: 50, height: 50 }, element)).toBe(0);
    expect(visibleShare({ left: 0, top: -60, width: 50, height: 50 }, element)).toBe(0);
  });

  it("puts the label above, below, or inside when neither fits", () => {
    const element = { width: 360, height: 640 };
    expect(labelSide({ left: 0, top: 200, width: 100, height: 100 }, element, 80)).toBe("above");
    expect(labelSide({ left: 0, top: 90, width: 100, height: 100 }, element, 80)).toBe("below");
    expect(labelSide({ left: 0, top: 0, width: 360, height: 640 }, element, 80)).toBe("inside");
  });
});

/** A textured sample (a smooth pattern with detail to match), moved by (dx, dy) pixels. */
function sample(dx: number, dy: number): Uint8Array {
  const pixels = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const u = x - dx;
      const v = y - dy;
      pixels[y * SAMPLE_WIDTH + x] =
        128 + 60 * Math.sin(u * 0.7) + 50 * Math.cos(v * 0.45 + u * 0.2);
    }
  }
  return pixels;
}

describe("the camera's own motion", () => {
  it("is the whole picture's shift between two samples", () => {
    const shift = globalShift(sample(0, 0), sample(3, -2));
    expect(shift.x).toBeCloseTo(3 / SAMPLE_WIDTH);
    expect(shift.y).toBeCloseTo(-2 / SAMPLE_HEIGHT);
  });

  it("is nothing for a still camera or a blank wall", () => {
    expect(globalShift(sample(1, 1), sample(1, 1))).toEqual({ x: 0, y: 0 });
    const wall = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT).fill(90);
    expect(globalShift(wall, wall)).toEqual({ x: 0, y: 0 });
  });

  it("reads a frame's colours as brightness", () => {
    expect([...luminance(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))]).toEqual([
      255, 0,
    ]);
  });

  it("adds, subtracts and moves boxes", () => {
    expect(plus({ x: 0.1, y: 0.2 }, { x: 0.1, y: -0.1 })).toEqual({ x: 0.2, y: 0.1 });
    expect(minus({ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.5 })).toEqual({ x: 0.25, y: 0 });
    expect(moved(box, { x: 0.25, y: -0.25 })).toEqual({ ...box, x: 0.5, y: 0.25 });
  });
});

const mark = (id: string) => ({ id, target: `the ${id}`, label: id, box });

describe("the board of marks", () => {
  it("keeps two at most, the newest", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    board.add(mark("lamp"), 0);
    board.add(mark("door"), 0);
    expect(board.list().map((each) => each.id)).toEqual(["lamp", "door"]);
  });

  it("moves every mark with the camera, and counts the drift", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    board.move({ x: 0, y: 0 });
    board.move({ x: 0.1, y: 0 });
    expect(board.list()[0]?.box.x).toBeCloseTo(0.35);
    expect(board.list()[0]?.drift).toBeCloseTo(0.1);
  });

  it("locates again after a quarter frame of motion, no sooner than every two seconds", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    board.move({ x: 0.3, y: 0 });
    expect(board.due(1000)).toBeNull();
    expect(board.due(2000)?.id).toBe("window");
    // One locate at a time.
    expect(board.due(9000)).toBeNull();
    board.relocated("window", { ...box, x: 0.6 }, 2500);
    expect(board.list()[0]).toMatchObject({ box: { x: 0.6 }, drift: 0, foundAt: 2500 });
  });

  it("locates again after four seconds without motion", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    expect(board.due(3000)).toBeNull();
    expect(board.due(4000)?.id).toBe("window");
  });

  it("fades a mark whose thing is gone, then lets it go", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    expect(board.due(4000)?.id).toBe("window");
    board.relocated("window", null, 4500);
    expect(board.list()[0]?.fadingAt).toBe(4500);
    // A late answer for a fading mark, or for one that's gone, changes nothing.
    board.relocated("window", box, 4600);
    board.relocated("gone", box, 4600);
    expect(board.list()[0]?.fadingAt).toBe(4500);
    expect(board.due(9000)).toBeNull();
    board.tick(4500 + MARK_FADE_MS);
    expect(board.list()).toEqual([]);
  });

  it("fades a mark after its lifetime, renewed each time it's found again", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    board.tick(MARK_LIFETIME_MS - 1);
    expect(board.list()[0]?.fadingAt).toBeNull();
    board.tick(MARK_LIFETIME_MS);
    expect(board.list()[0]?.fadingAt).toBe(MARK_LIFETIME_MS);
    // A new mark replaces faded ones rather than sharing the two places with them.
    board.add(mark("lamp"), MARK_LIFETIME_MS);
    board.add(mark("door"), MARK_LIFETIME_MS);
    expect(board.list().map((each) => each.id)).toEqual(["lamp", "door"]);
  });

  it("locates again ten times a shot at most, and a new shot starts over", () => {
    const board = new MarkBoard();
    board.add(mark("window"), 0);
    let now = 0;
    for (let round = 0; round < RELOCATES_PER_SHOT; round += 1) {
      now += 4000;
      expect(board.due(now)).not.toBeNull();
      board.relocated("window", box, now);
    }
    expect(board.due(now + 4000)).toBeNull();
    board.newShot();
    expect(board.list()).toEqual([]);
    board.add(mark("lamp"), now + 4000);
    expect(board.due(now + 8000)?.id).toBe("lamp");
    board.clear();
    expect(board.list()).toEqual([]);
  });
});
