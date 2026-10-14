import { afterEach, describe, expect, it, vi } from "vitest";
import { useCountdown } from "@/modules/director/hooks/use-countdown";
import { renderHook, until } from "./support";

afterEach(() => {
  vi.useRealTimers();
});

/** A second on the countdown's clock, once its timer for this number is set. */
async function second(hook: { current: { left: number | null } }, showing: number) {
  await until(() => expect(hook.current.left).toBe(showing));
  await until(() => expect(vi.getTimerCount()).toBe(1));
  vi.advanceTimersByTime(999);
  expect(hook.current.left).toBe(showing);
  vi.advanceTimersByTime(1);
}

describe("useCountdown", () => {
  it("counts down a second at a time from 3, then calls the latest onDone once", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    let onDone = first;
    const hook = await renderHook(() => useCountdown(() => onDone()));
    expect(hook.current.left).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    hook.current.start();
    await second(hook, 3);
    await second(hook, 2);
    onDone = latest;
    hook.rerender();
    await second(hook, 1);
    await until(() => expect(hook.current.left).toBeNull());
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();

    // Nothing more is due once it's done.
    vi.advanceTimersByTime(5_000);
    expect(latest).toHaveBeenCalledOnce();
  });

  it("starts from the number it's given", async () => {
    const onDone = vi.fn();
    const hook = await renderHook(() => useCountdown(onDone, 2));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hook.current.start();
    await second(hook, 2);
    await second(hook, 1);
    await until(() => expect(onDone.mock.calls.length).toBe(1));
  });

  it("never finishes once the screen is gone", async () => {
    const onDone = vi.fn();
    const hook = await renderHook(() => useCountdown(onDone));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hook.current.start();
    await until(() => expect(vi.getTimerCount()).toBe(1));
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
  });
});
