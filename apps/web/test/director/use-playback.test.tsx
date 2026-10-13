import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayback } from "@/modules/director/hooks/use-playback";
import { renderHook, until } from "./support";

afterEach(() => {
  vi.useRealTimers();
});

/** The page's frames and clock, moved on by the test. */
const fakeFrames = () =>
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });

describe("usePlayback", () => {
  it("plays from where it is to the end of the edit, and stops there", async () => {
    const hook = await renderHook(() => usePlayback(2));
    fakeFrames();
    expect([hook.current.time, hook.current.playing]).toEqual([0, false]);

    hook.current.play();
    await until(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(800);
    await until(() => expect(hook.current.time).toBeCloseTo(0.8, 1));
    expect(hook.current.playing).toBe(true);
    expect(hook.current.clock()).toBe(hook.current.time);

    vi.advanceTimersByTime(2_000);
    await until(() => expect(hook.current.playing).toBe(false));
    expect(hook.current.time).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds still while paused, and seeks within the edit", async () => {
    const hook = await renderHook(() => usePlayback(2));
    fakeFrames();
    hook.current.seek(0.5);
    await until(() => expect(hook.current.time).toBe(0.5));
    hook.current.play();
    await until(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(500);
    await until(() => expect(hook.current.time).toBeCloseTo(1, 1));

    hook.current.pause();
    await until(() => expect(vi.getTimerCount()).toBe(0));
    const paused = hook.current.time;
    vi.advanceTimersByTime(500);
    expect(hook.current.time).toBe(paused);
    expect(hook.current.playing).toBe(false);

    hook.current.seek(-3);
    await until(() => expect(hook.current.time).toBe(0));
    hook.current.seek(9);
    await until(() => expect(hook.current.time).toBe(2));
    expect(hook.current.clock()).toBe(2);
  });

  it("starts over when played from the end", async () => {
    const hook = await renderHook(() => usePlayback(2));
    fakeFrames();
    hook.current.seek(1.98);
    await until(() => expect(hook.current.time).toBe(1.98));
    hook.current.play();
    await until(() => expect([hook.current.time, hook.current.playing]).toEqual([0, true]));
    await until(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(300);
    await until(() => expect(hook.current.time).toBeCloseTo(0.3, 1));
  });
});
