/**
 * The viewfinder's geometry. A shot plan places things as fractions of a 9:16 portrait
 * frame, and the viewfinder is exactly that: the middle of the camera's frame, cropped to
 * 9:16 the way `object-cover` does. A camera frame of any shape (a laptop's 16:9, a
 * phone's 3:4) maps into it with `viewCrop`, so the frame sent to Gemini, the photo, the
 * joints MediaPipe finds and the outlines drawn all share one space.
 */
import type { Body, Point } from "./pose";

export const VIEW_ASPECT = 9 / 16;

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of a `width`×`height` camera frame the viewfinder shows, in frame pixels. */
export function viewCrop(width: number, height: number): Crop {
  if (width / height > VIEW_ASPECT) {
    const cropped = height * VIEW_ASPECT;
    return { x: (width - cropped) / 2, y: 0, width: cropped, height };
  }
  const cropped = width / VIEW_ASPECT;
  return { x: 0, y: (height - cropped) / 2, width, height: cropped };
}

/** A point given as a fraction of the camera frame, as a fraction of the viewfinder. */
export function toView(point: Point, width: number, height: number): Point {
  const crop = viewCrop(width, height);
  return {
    x: (point.x * width - crop.x) / crop.width,
    y: (point.y * height - crop.y) / crop.height,
  };
}

/** A body found in the camera frame, in the viewfinder's space. */
export function bodyInView(body: Body, width: number, height: number): Body {
  return Object.fromEntries(
    Object.entries(body).map(([name, point]) => [name, toView(point, width, height)]),
  );
}
