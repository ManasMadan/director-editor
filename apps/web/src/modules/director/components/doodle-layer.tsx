"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { type DoodleScene, drawDoodles } from "../lib/doodle";
import { token } from "../lib/ink";

/**
 * Director's doodles over the viewfinder (lib/doodle.ts), redrawn every frame so the
 * arrows move. The canvas is never mirrored: the doodles flip camera-frame positions
 * themselves, so their arrows and labels read the right way round.
 */
export function DoodleLayer({ scene }: { scene: DoodleScene }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(scene);
  useLayoutEffect(() => {
    latest.current = scene;
  }, [scene]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) {
      return;
    }
    const colors = {
      locked: token("--guide"),
      waiting: token("--guide-warn"),
      ink: token("--studio-foreground"),
      shade: token("--studio"),
    };
    const begun = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * ratio);
      const height = Math.round(element.clientHeight * ratio);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      drawDoodles({ ctx, width, height }, latest.current, colors, (now - begun) / 1000);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
  );
}
