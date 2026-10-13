/**
 * What Director remembers about the member between sessions, to coach them the way it
 * did last time: whether they like it talking and listening, how long a countdown they
 * need (learned from takes that started late), the light problems they keep running
 * into, the props they like, and how their takes have gone.
 *
 * The seam: `MemoryStore`. Today it is this browser's storage (`browserMemory`), so the
 * memory stays on the member's device and starts empty on a new one. To keep it across
 * devices, implement `MemoryStore` over an API procedure (a `director_memory` row per
 * member, under row-level security like `ai.director_take`) and pass it to `useMemory`;
 * nothing else changes. Whatever the store, what it returns is parsed: browser storage
 * is outside the app's control, and a value from an older version or another tab must
 * never break the camera screen.
 */
import * as z from "zod";
import type { Light } from "./frame-stats";
import { isThing, type Thing } from "./things";

const COUNTDOWNS = [3, 5, 10] as const;
const LIGHT_PROBLEMS = ["too-dark", "too-bright", "backlit"] as const;
export type Countdown = (typeof COUNTDOWNS)[number];
/** How many recent take starts the learned countdown looks at. */
const RECENT_STARTS = 3;

const memorySchema = z.object({
  version: z.literal(1),
  sessions: z.number().int().nonnegative(),
  takesKept: z.number().int().nonnegative(),
  retakes: z.number().int().nonnegative(),
  bestScore: z.number().int().min(0).max(100).nullable(),
  speak: z.boolean(),
  listen: z.boolean(),
  /** Chosen by the member; null lets Director learn it. */
  countdown: z.union([z.literal(3), z.literal(5), z.literal(10)]).nullable(),
  /** Whether each recent take started late (newest last). */
  lateStarts: z.array(z.boolean()).max(RECENT_STARTS),
  /** The light problems seen in kept takes, by kind. */
  light: z.partialRecord(z.enum(LIGHT_PROBLEMS), z.number().int().nonnegative()),
  /** Things seen in the frame of kept takes, by how often. */
  things: z.record(z.string(), z.number().int().nonnegative()),
});
export type Memory = z.infer<typeof memorySchema>;

export const FRESH: Memory = {
  version: 1,
  sessions: 0,
  takesKept: 0,
  retakes: 0,
  bestScore: null,
  speak: true,
  listen: true,
  countdown: null,
  lateStarts: [],
  light: {},
  things: {},
};

export type MemoryEvent =
  | { type: "opened" }
  | { type: "kept"; score: number; lateStart: boolean; light: Light | null; things: Thing[] }
  | { type: "retake"; lateStart: boolean }
  | { type: "prefer"; speak?: boolean; listen?: boolean; countdown?: Countdown | null };

const recent = (starts: readonly boolean[], late: boolean) =>
  [...starts, late].slice(-RECENT_STARTS);

function kept(memory: Memory, event: Extract<MemoryEvent, { type: "kept" }>): Memory {
  const light = { ...memory.light };
  if (event.light && event.light !== "good") {
    light[event.light] = (light[event.light] ?? 0) + 1;
  }
  const things = { ...memory.things };
  for (const thing of new Set(event.things)) {
    things[thing] = (things[thing] ?? 0) + 1;
  }
  return {
    ...memory,
    takesKept: memory.takesKept + 1,
    bestScore: Math.max(memory.bestScore ?? 0, event.score),
    lateStarts: recent(memory.lateStarts, event.lateStart),
    light,
    things,
  };
}

/** The memory after something happened. */
export function remember(memory: Memory, event: MemoryEvent): Memory {
  switch (event.type) {
    case "opened":
      return { ...memory, sessions: memory.sessions + 1 };
    case "kept":
      return kept(memory, event);
    case "retake":
      return {
        ...memory,
        retakes: memory.retakes + 1,
        lateStarts: recent(memory.lateStarts, event.lateStart),
      };
    case "prefer":
      return {
        ...memory,
        speak: event.speak ?? memory.speak,
        listen: event.listen ?? memory.listen,
        countdown: event.countdown === undefined ? memory.countdown : event.countdown,
      };
  }
}

/**
 * The countdown to give: the member's choice, else a longer one once most recent takes
 * started late (they needed a beat more to get set), else three seconds.
 */
export function countdownOf(memory: Memory): Countdown {
  if (memory.countdown !== null) {
    return memory.countdown;
  }
  const late = memory.lateStarts.filter(Boolean).length;
  return memory.lateStarts.length >= 2 && late * 2 > memory.lateStarts.length ? 5 : 3;
}

/** The light problem the member has had most, if any has come up twice. */
export function usualLight(memory: Memory): Exclude<Light, "good"> | null {
  const [worst] = Object.entries(memory.light)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a);
  return worst ? z.enum(LIGHT_PROBLEMS).parse(worst[0]) : null;
}

/** The thing most often in the member's kept takes, once it's been in two. */
export function favouriteThing(memory: Memory): Thing | null {
  const [favourite] = Object.entries(memory.things)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .flatMap(([thing]) => (isThing(thing) ? [thing] : []));
  return favourite ?? null;
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

/** This browser's storage; private windows and blocked storage remember nothing. */
export const browserMemory: MemoryStore = {
  load() {
    try {
      return parseMemory(window.localStorage.getItem(KEY));
    } catch {
      // Storage refused (a private window, site data blocked): no memory this time.
      return FRESH;
    }
  },
  save(memory) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {
      // Storage refused or full: Director just won't remember this session.
    }
  },
};
