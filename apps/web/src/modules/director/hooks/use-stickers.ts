"use client";

import { useCallback, useRef, useState } from "react";
import { type Sticker, type StickerKind, stickerAlive } from "../lib/doodle";
import type { Point } from "../lib/pose";

/** The stickers on the frame now; each lands with `add` and the doodles fade it out. */
export function useStickers() {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const count = useRef(0);
  const add = useCallback((kind: StickerKind, at: Point, label = "") => {
    count.current += 1;
    const id = count.current;
    const born = performance.now() / 1000;
    setStickers((now) => [
      ...now.filter((sticker) => stickerAlive(sticker, born)),
      { id, kind, born, at, label },
    ]);
  }, []);
  return { stickers, add };
}
