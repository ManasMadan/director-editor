/**
 * Director's marks on the picture: a box Gemini located on a real thing in the camera,
 * pinned to it as the camera moves, and drawn over the viewfinder.
 *
 * A mark lives in the coordinates of the frame Gemini looked at: fractions of the 9:16
 * crop the viewfinder shows (`viewCrop`), unmirrored. Everything else is derived from
 * that:
 * - On screen, `toScreen` maps it through the <video>'s `object-cover` crop and mirrors
 *   it for the front camera's mirrored preview; over half outside the picture, it isn't
 *   drawn (it fades out).
 * - Between locates it moves with the camera's own motion: `globalShift` compares two
 *   small greyscale samples of the picture (block matching) and the board moves every
 *   mark by the shift. The shift since the frame a locate looked at is applied when its
 *   answer arrives, so the time Gemini took doesn't misplace the mark.
 * - After a quarter of a frame of motion, or 4 s, a mark is located again (at most every
 *   2 s, ten times a shot); if the thing is gone, it fades. Each mark shows for 8 s,
 *   renewed by each locate that finds it again, and only two show at once.
 */
import type { FrameBox } from "@repo/contracts/api";
import { SECOND_MS } from "@repo/contracts/time";
import { viewCrop } from "./view";

export interface Size {
  width: number;
  height: number;
}

/** A box in the <video> element's own pixels, as drawn. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far the picture moved, as fractions of the frame (content moving right is +x). */
export interface Shift {
  x: number;
  y: number;
}

export const NO_SHIFT: Shift = { x: 0, y: 0 };

/** At most this many marks show at once; a new one replaces the oldest. */
const MAX_MARKS = 2;
/** How long a mark shows after it was last found. */
export const MARK_LIFETIME_MS = 8 * SECOND_MS;
/** How long a mark takes to fade out before it's gone. */
export const MARK_FADE_MS = 300;
/** A mark is located again after this much motion (a quarter of the frame)... */
const RELOCATE_AFTER_SHIFT = 0.25;
/** ...or this long since it was last located... */
const RELOCATE_AFTER_MS = 4 * SECOND_MS;
/** ...but never sooner than this after the last locate of any mark, */
const RELOCATE_GAP_MS = 2 * SECOND_MS;
/** ...and no more than this many times in one shot. */
export const RELOCATES_PER_SHOT = 10;
/** Less than this share of a mark inside the picture, and it isn't drawn. */
export const MIN_VISIBLE_SHARE = 0.5;

/** The motion samples: the viewfinder's 9:16 crop, this small, in grey. */
export const SAMPLE_WIDTH = 36;
export const SAMPLE_HEIGHT = 64;
/** The farthest the picture is searched for a match, in sample pixels, each way. */
const SAMPLE_REACH = 6;

/**
 * Where a box (fractions of the 9:16 crop of a `video`-sized camera frame) lands on an
 * `element`-sized <video> drawn with `object-cover`, mirrored for the front camera.
 */
export function toScreen(box: FrameBox, video: Size, element: Size, mirrored: boolean): Rect {
  const crop = viewCrop(video.width, video.height);
  const scale = Math.max(element.width / video.width, element.height / video.height);
  const offsetX = (video.width * scale - element.width) / 2;
  const offsetY = (video.height * scale - element.height) / 2;
  const left = (crop.x + box.x * crop.width) * scale - offsetX;
  const top = (crop.y + box.y * crop.height) * scale - offsetY;
  const width = box.width * crop.width * scale;
  const height = box.height * crop.height * scale;
  return { left: mirrored ? element.width - left - width : left, top, width, height };
}

/** The share of `rect` inside an `element`-sized picture, from 0 to 1. */
export function visibleShare(rect: Rect, element: Size): number {
  const width = Math.min(rect.left + rect.width, element.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.top + rect.height, element.height) - Math.max(rect.top, 0);
  if (width <= 0 || height <= 0) {
    return 0;
  }
  return (width * height) / (rect.width * rect.height);
}

/** An RGBA image's pixels as luminance, one byte each. */
export function luminance(rgba: Uint8ClampedArray): Uint8Array {
  const grey = new Uint8Array(rgba.length / 4);
  for (let at = 0; at < grey.length; at += 1) {
    const red = rgba[at * 4] ?? 0;
    const green = rgba[at * 4 + 1] ?? 0;
    const blue = rgba[at * 4 + 2] ?? 0;
    grey[at] = (red * 77 + green * 150 + blue * 29) >> 8;
  }
  return grey;
}

/**
 * The mean difference between `next` and `previous` moved by (dx, dy), over the middle
 * of the sample (the margin a move could bring in from outside is left out).
 */
function difference(previous: Uint8Array, next: Uint8Array, dx: number, dy: number): number {
  let total = 0;
  let count = 0;
  for (let y = SAMPLE_REACH; y < SAMPLE_HEIGHT - SAMPLE_REACH; y += 1) {
    for (let x = SAMPLE_REACH; x < SAMPLE_WIDTH - SAMPLE_REACH; x += 1) {
      const now = next[y * SAMPLE_WIDTH + x] ?? 0;
      const before = previous[(y - dy) * SAMPLE_WIDTH + (x - dx)] ?? 0;
      total += Math.abs(now - before);
      count += 1;
    }
  }
  return total / count;
}

/**
 * How far the picture moved from `previous` to `next` (two SAMPLE_WIDTH × SAMPLE_HEIGHT
 * greyscale samples), as fractions of the frame: the whole-picture shift that matches
 * best. A still camera, or a picture with nothing to match (a blank wall), is no shift.
 */
export function globalShift(previous: Uint8Array, next: Uint8Array): Shift {
  let best = { dx: 0, dy: 0, score: difference(previous, next, 0, 0) };
  for (let dy = -SAMPLE_REACH; dy <= SAMPLE_REACH; dy += 1) {
    for (let dx = -SAMPLE_REACH; dx <= SAMPLE_REACH; dx += 1) {
      const score = difference(previous, next, dx, dy);
      // Only a clearly better match moves the mark, so noise on a still picture doesn't.
      if (score < best.score - 0.5) {
        best = { dx, dy, score };
      }
    }
  }
  return { x: best.dx / SAMPLE_WIDTH, y: best.dy / SAMPLE_HEIGHT };
}

export function plus(a: Shift, b: Shift): Shift {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function minus(a: Shift, b: Shift): Shift {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function moved(box: FrameBox, by: Shift): FrameBox {
  return { ...box, x: box.x + by.x, y: box.y + by.y };
}

export interface Mark {
  /** The tool call's id: one mark per call. */
  id: string;
  /** What Director pointed at, to find it again. */
  target: string;
  label: string;
  box: FrameBox;
  /** When it was last found: it shows for MARK_LIFETIME_MS from then. */
  foundAt: number;
  /** When it was last asked for (found or not), for the re-locate cadence. */
  locatedAt: number;
  /** How far the picture has moved since it was last located. */
  drift: number;
  /** When it started fading out (gone from view, or not found again); null while shown. */
  fadingAt: number | null;
}

/**
 * The marks on screen and the rules they follow. Plain state with the clock passed in, so
 * the shoot screen's hook (use-marks.ts) owns time and the camera, and this owns the rules.
 */
export class MarkBoard {
  private marks: Mark[] = [];
  private relocations = 0;
  private lastLocateAt = Number.NEGATIVE_INFINITY;
  private locating = false;

  list(): readonly Mark[] {
    return this.marks;
  }

  /** A newly located mark; the oldest goes when there are already MAX_MARKS. */
  add(mark: { id: string; target: string; label: string; box: FrameBox }, now: number) {
    const fresh: Mark = { ...mark, foundAt: now, locatedAt: now, drift: 0, fadingAt: null };
    this.marks = [...this.marks.filter((old) => old.fadingAt === null), fresh].slice(-MAX_MARKS);
    this.lastLocateAt = now;
  }

  /** The camera moved: every mark moves with what it's on. */
  move(by: Shift) {
    if (by.x === 0 && by.y === 0) {
      return;
    }
    const distance = Math.hypot(by.x, by.y);
    this.marks = this.marks.map((mark) => ({
      ...mark,
      box: moved(mark.box, by),
      drift: mark.drift + distance,
    }));
  }

  /**
   * The mark to locate again now, if one is due and the cadence allows it; it's counted
   * as asked for, so the next call won't return it again before it's answered.
   */
  due(now: number): Mark | null {
    if (
      this.locating ||
      this.relocations >= RELOCATES_PER_SHOT ||
      now - this.lastLocateAt < RELOCATE_GAP_MS
    ) {
      return null;
    }
    const mark = this.marks.find(
      (each) =>
        each.fadingAt === null &&
        (each.drift >= RELOCATE_AFTER_SHIFT || now - each.locatedAt >= RELOCATE_AFTER_MS),
    );
    if (!mark) {
      return null;
    }
    this.locating = true;
    this.relocations += 1;
    this.lastLocateAt = now;
    return mark;
  }

  /**
   * A re-locate's answer: the mark moves to where the thing is now (`box`, already moved
   * by the shift since the frame Gemini looked at), or fades when it's gone.
   */
  relocated(id: string, box: FrameBox | null, now: number) {
    this.locating = false;
    this.marks = this.marks.map((mark) => {
      if (mark.id !== id || mark.fadingAt !== null) {
        return mark;
      }
      return box
        ? { ...mark, box, foundAt: now, locatedAt: now, drift: 0 }
        : { ...mark, locatedAt: now, fadingAt: now };
    });
  }

  /** Starts marks past their lifetime fading, and lets faded ones go. */
  tick(now: number) {
    this.marks = this.marks
      .filter((mark) => mark.fadingAt === null || now - mark.fadingAt < MARK_FADE_MS)
      .map((mark) =>
        mark.fadingAt === null && now - mark.foundAt >= MARK_LIFETIME_MS
          ? { ...mark, fadingAt: now }
          : mark,
      );
  }

  /** Every mark goes at once: a new shot, a take starting, the camera flipped. */
  clear() {
    this.marks = [];
    this.locating = false;
  }

  /** A new shot: its own allowance of re-locates. */
  newShot() {
    this.clear();
    this.relocations = 0;
  }
}

/** The label's height and the gap between it and the box, in CSS pixels. */
const LABEL_HEIGHT = 30;
const LABEL_GAP = 6;

/**
 * Where a mark's label goes: above the box when there's room inside the picture's safe
 * area, below it otherwise, and inside it when neither fits (a box filling the frame).
 */
export function labelSide(
  rect: Rect,
  element: Size,
  safeTop: number,
): "above" | "below" | "inside" {
  if (rect.top - LABEL_HEIGHT - LABEL_GAP >= safeTop) {
    return "above";
  }
  if (rect.top + rect.height + LABEL_GAP + LABEL_HEIGHT <= element.height) {
    return "below";
  }
  return "inside";
}
