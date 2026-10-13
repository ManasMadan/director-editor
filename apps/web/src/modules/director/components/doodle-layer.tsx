"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { type DoodleScene, drawDoodles, glideScene } from "../lib/doodle";
import { token } from "../lib/ink";
import { Glider } from "../lib/spring";

/**
 * Director's doodles over the viewfinder (lib/doodle.ts), redrawn every frame so the
 * lines boil and the arrows move, with every tracked position gliding on a spring. The
 * canvas is never mirrored: the doodles flip camera-frame positions themselves, so their
 * arrows and labels read the right way round.
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
      pop: token("--doodle-pop"),
      paper: token("--doodle-paper"),
      record: token("--record"),
    };
    const font = token("--font-hand");
    // The canvas draws text in a font only once it has loaded; until then, the fallback.
    void document.fonts?.load(`24px ${font}`);
    const glider = new Glider();
    let frame = 0;
    const draw = (now: number) => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * ratio);
      const height = Math.round(element.clientHeight * ratio);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      const time = now / 1000;
      glider.frame(time);
      drawDoodles({ ctx, width, height, font }, glideScene(latest.current, glider), colors, time);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
  );
}
