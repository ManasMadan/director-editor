"use client";

import { useCallback, useState } from "react";
import { browserMemory, type MemoryEvent, type MemoryStore, remember } from "../lib/memory";

/**
 * Director's memory of the member (lib/memory.ts), read once when the camera screen
 * opens and saved after each change. `store` is the seam: this browser's storage today.
 */
export function useMemory(store: MemoryStore = browserMemory) {
  // What Director knew when the screen opened: the greeting is about last time, not now.
  const [before] = useState(() => store.load());
  const [memory, setMemory] = useState(before);
  const record = useCallback(
    (event: MemoryEvent) =>
      setMemory((now) => {
        const next = remember(now, event);
        store.save(next);
        return next;
      }),
    [store],
  );
  return { before, memory, record };
}
