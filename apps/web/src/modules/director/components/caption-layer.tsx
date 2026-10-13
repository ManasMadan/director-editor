"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { drawCaption } from "../lib/caption-draw";
import { type CaptionLine, type CaptionStyle, captionAt } from "../lib/captions";
import { captionInk } from "../lib/ink";

/**
 * The captions over a playing video, drawn each frame at `clock()` seconds with the same
 * code that burns them into the finished short (lib/caption-draw.ts), so the preview shows
 * exactly what the render will.
 */
export function CaptionLayer({
  lines,
  style,
  clock,
}: {
  lines: readonly CaptionLine[];
  style: CaptionStyle;
  clock: () => number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ lines, style, clock });
  useLayoutEffect(() => {
    latest.current = { lines, style, clock };
  }, [lines, style, clock]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) {
      return;
    }
    const ink = captionInk();
    let frame = 0;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * ratio);
      const height = Math.round(element.clientHeight * ratio);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      const now = latest.current;
      ctx.clearRect(0, 0, width, height);
      drawCaption(ctx, width, height, captionAt(now.lines, now.clock()), now.style, ink);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
  );
}
