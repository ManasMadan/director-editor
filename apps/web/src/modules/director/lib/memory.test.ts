import { afterEach, describe, expect, it, vi } from "vitest";
import type { Light } from "./frame-stats";
import {
  browserMemory,
  countdownOf,
  FRESH,
  favouriteThing,
  type Memory,
  parseMemory,
  remember,
  usualLight,
} from "./memory";
import type { Thing } from "./things";

const keep = (
  memory: Memory,
  overrides: { score?: number; lateStart?: boolean; light?: Light | null; things?: Thing[] } = {},
) =>
  remember(memory, {
    type: "kept",
    score: 80,
    lateStart: false,
    light: "good",
    things: [],
    ...overrides,
  });

describe("Director's memory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts sessions, kept takes and retakes, and the best score", () => {
    let memory = remember(FRESH, { type: "opened" });
    memory = keep(memory, { score: 70 });
    memory = keep(memory, { score: 91 });
    memory = remember(memory, { type: "retake", lateStart: false });
    expect(memory).toMatchObject({ sessions: 1, takesKept: 2, retakes: 1, bestScore: 91 });
  });

  it("learns a longer countdown when most takes start late, until the member picks one", () => {
    expect(countdownOf(FRESH)).toBe(3);
    let memory = remember(FRESH, { type: "retake", lateStart: true });
    expect(countdownOf(memory)).toBe(3);
    memory = keep(memory, { lateStart: true });
    expect(countdownOf(memory)).toBe(5);
    memory = keep(keep(keep(memory)));
    expect(memory.lateStarts).toEqual([false, false, false]);
    expect(countdownOf(memory)).toBe(3);
    expect(countdownOf(remember(memory, { type: "prefer", countdown: 10 }))).toBe(10);
  });

  it("remembers the light problems and props that keep coming up", () => {
    let memory = keep(FRESH, { light: "too-dark", things: ["plant", "plant", "cup"] });
    expect(usualLight(memory)).toBeNull();
    expect(favouriteThing(memory)).toBeNull();
    memory = keep(memory, { light: "too-dark", things: ["plant"] });
    memory = keep(memory, { light: null });
    expect(usualLight(memory)).toBe("too-dark");
    expect(favouriteThing(memory)).toBe("plant");
    expect(memory.things).toEqual({ plant: 2, cup: 1 });
  });

  it("keeps the member's preferences", () => {
    const memory = remember(FRESH, { type: "prefer", speak: false, listen: false });
    expect(memory).toMatchObject({ speak: false, listen: false, countdown: null });
    const chosen = remember(memory, { type: "prefer", countdown: 5 });
    expect(chosen).toMatchObject({ speak: false, listen: false, countdown: 5 });
    expect(remember(chosen, { type: "prefer", countdown: null }).countdown).toBeNull();
  });

  it("forgets a stored favourite that isn't a thing Director knows", () => {
    expect(favouriteThing({ ...FRESH, things: { spoon: 5, cup: 2 } })).toBe("cup");
  });

  it("starts afresh from a stored value it can't read", () => {
    expect(parseMemory(null)).toBe(FRESH);
    expect(parseMemory("not json")).toBe(FRESH);
    expect(parseMemory('{"version":2}')).toBe(FRESH);
    const stored = keep(FRESH);
    expect(parseMemory(JSON.stringify(stored))).toEqual(stored);
  });

  it("keeps the memory in the browser, and copes when storage is refused", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
      },
    });
    const mine = browserMemory("user-1");
    expect(mine.load()).toBe(FRESH);
    mine.save(keep(FRESH));
    expect(mine.load().takesKept).toBe(1);
    // Another account on the same browser starts afresh.
    expect(browserMemory("user-2").load()).toBe(FRESH);

    const refuse = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("window", { localStorage: { getItem: refuse, setItem: refuse } });
    expect(mine.load()).toBe(FRESH);
    expect(() => mine.save(FRESH)).not.toThrow();
  });

  it("names the light problem that came up most, of several", () => {
    let memory = FRESH;
    for (const light of ["backlit", "too-dark", "too-dark", "backlit", "too-dark"] as const) {
      memory = keep(memory, { light });
    }
    expect(usualLight(memory)).toBe("too-dark");
  });
});
