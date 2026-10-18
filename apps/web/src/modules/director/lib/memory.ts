/**
 * What Director remembers about the member between shoots. Today that's only how many
 * shoots they've started, so the shoot screen explains itself the first time and gets
 * straight to it after; what the member tells Director (where they're filming, what they
 * don't want to do) joins it here once Director picks those up from the conversation.
 *
 * The seam: `MemoryStore`. Today it is this browser's storage (`browserMemory`), so the
 * memory stays on the member's device and starts empty on a new one. It is kept per
 * account: on a shared computer, the next person to sign in starts afresh rather than
 * with someone else's. To keep it across devices, implement `MemoryStore` over an API
 * procedure (a `director_memory` row per member, under row-level security like
 * `ai.director_take`) and pass it to `useMemory`; nothing else changes. Whatever the
 * store, what it returns is parsed: browser storage is outside the app's control, and a
 * value from an older version or another tab must never break the shoot screen.
 */
import * as z from "zod";

// An older version's value has more in it: what isn't here any more is dropped on read.
const memorySchema = z.object({
  version: z.literal(1),
  /** How many shoots the member has started with the "Start shooting" tap. */
  sessions: z.number().int().nonnegative(),
});
export type Memory = z.infer<typeof memorySchema>;

export const FRESH: Memory = { version: 1, sessions: 0 };

export type MemoryEvent = { type: "started" };

/** The memory after something happened. */
export function remember(memory: Memory, event: MemoryEvent): Memory {
  switch (event.type) {
    case "started":
      return { ...memory, sessions: memory.sessions + 1 };
  }
}

/** Where the memory is kept: the seam (see the top of this file). */
export interface MemoryStore {
  load(): Memory;
  save(memory: Memory): void;
}

const KEY = "director.memory";

/** A stored value as memory, or a fresh one for anything unreadable. */
export function parseMemory(stored: string | null): Memory {
  if (stored === null) {
    return FRESH;
  }
  try {
    const parsed = memorySchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : FRESH;
  } catch {
    // Not JSON (another app's value, a half-written one): start afresh rather than fail.
    return FRESH;
  }
}

/** This browser's storage, for one account; private windows and blocked storage remember nothing. */
export function browserMemory(owner: string): MemoryStore {
  const key = `${KEY}.${owner}`;
  return {
    load() {
      try {
        return parseMemory(window.localStorage.getItem(key));
      } catch {
        // Storage refused (a private window, site data blocked): no memory this time.
        return FRESH;
      }
    },
    save(memory) {
      try {
        window.localStorage.setItem(key, JSON.stringify(memory));
      } catch {
        // Storage refused or full: Director just won't remember this shoot.
      }
    },
  };
}
