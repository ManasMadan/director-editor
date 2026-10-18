import { afterEach, describe, expect, it, vi } from "vitest";
import { browserMemory, FRESH, parseMemory, remember } from "./memory";

describe("Director's memory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts the shoots the member has started", () => {
    const memory = remember(remember(FRESH, { type: "started" }), { type: "started" });
    expect(memory).toEqual({ version: 1, sessions: 2 });
  });

  it("starts afresh from a stored value it can't read, and keeps what it can of an older one", () => {
    expect(parseMemory(null)).toBe(FRESH);
    expect(parseMemory("not json")).toBe(FRESH);
    expect(parseMemory('{"version":2}')).toBe(FRESH);
    // An older version also learned countdowns and props: only what's still used stays.
    const older = { version: 1, sessions: 4, countdown: 5, things: { cup: 2 } };
    expect(parseMemory(JSON.stringify(older))).toEqual({ version: 1, sessions: 4 });
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
    mine.save(remember(FRESH, { type: "started" }));
    expect(mine.load().sessions).toBe(1);
    // Another account on the same browser starts afresh.
    expect(browserMemory("user-2").load()).toBe(FRESH);

    const refuse = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("window", { localStorage: { getItem: refuse, setItem: refuse } });
    expect(mine.load()).toBe(FRESH);
    expect(() => mine.save(FRESH)).not.toThrow();
  });
});
