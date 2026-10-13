"use client";

import { useCallback, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { browserMemory, FRESH, type Memory, type MemoryEvent, remember } from "../lib/memory";

interface Held {
  owner: string | null;
  /** What Director knew when the screen opened: the greeting is about last time, not now. */
  before: Memory;
  memory: Memory;
}

/**
 * Director's memory of the signed-in member (lib/memory.ts), read once their session is
 * known and saved after each change. The store is the seam: this browser's storage today,
 * one per account. Until the session is known, nothing is read or saved.
 */
export function useMemory() {
  const { data } = authClient.useSession();
  const owner = data?.user.id ?? null;
  const store = useMemo(() => (owner ? browserMemory(owner) : null), [owner]);
  const [held, setHeld] = useState<Held>({ owner: null, before: FRESH, memory: FRESH });
  // A different member (or the session arriving) means a different memory.
  if (held.owner !== owner) {
    const loaded = store?.load() ?? FRESH;
    setHeld({ owner, before: loaded, memory: loaded });
  }
  const record = useCallback(
    (event: MemoryEvent) =>
      setHeld((now) => {
        const memory = remember(now.memory, event);
        store?.save(memory);
        return { ...now, memory };
      }),
    [store],
  );
  return { before: held.before, memory: held.memory, record };
}
