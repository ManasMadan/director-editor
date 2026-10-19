/** The shoot screen's small hooks: what Director remembers, and keeping the screen awake. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { useMemory } from "@/modules/director/hooks/use-memory";
import { useWakeAudio, useWakeLock } from "@/modules/director/hooks/use-screen";
import { liveAudio, restLiveAudio } from "@/modules/director/lib/live-audio";
import { FRESH } from "@/modules/director/lib/memory";
import { signUp } from "../users";
import { deferred, renderHook } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useMemory", () => {
  it("remembers nothing until the member is known, then keeps their own", async () => {
    const signedOut = await renderHook(() => useMemory());
    expect(signedOut.current.memory).toBe(FRESH);
    signedOut.current.record({ type: "started" });
    await expect.poll(() => signedOut.current.memory.sessions).toBe(1);
    signedOut.unmount();

    const user = await signUp();
    window.localStorage.setItem(
      `director.memory.${user.id}`,
      JSON.stringify({ ...FRESH, sessions: 4 }),
    );
    const mine = await renderHook(() => useMemory());
    await expect.poll(() => mine.current.before.sessions).toBe(4);
    mine.current.record({ type: "started" });
    await expect.poll(() => mine.current.memory.sessions).toBe(5);
    // What the screen opened with stays as it was: the card was chosen from it.
    expect(mine.current.before.sessions).toBe(4);
    expect(JSON.parse(window.localStorage.getItem(`director.memory.${user.id}`) ?? "{}")).toEqual({
      version: 1,
      sessions: 5,
    });
  });
});

describe("the screen", () => {
  it("keeps the screen awake, takes the lock again on return, and lets it go", async () => {
    const release = vi.fn(async () => undefined);
    const request = vi
      .spyOn(navigator.wakeLock, "request")
      .mockResolvedValue({ release } as unknown as WakeLockSentinel);
    const hook = await renderHook(() => useWakeLock());
    await expect.poll(() => request.mock.calls.length).toBe(1);
    // Hidden: nothing to take; visible again: taken again.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => request.mock.calls.length).toBe(2);
    hook.unmount();
    await expect.poll(() => release.mock.calls.length).toBe(1);
  });

  it("lets go of a lock that arrives after the screen has gone", async () => {
    const release = vi.fn(async () => undefined);
    const asked = deferred<WakeLockSentinel>();
    const request = vi.spyOn(navigator.wakeLock, "request").mockReturnValue(asked.promise);
    const hook = await renderHook(() => useWakeLock());
    await expect.poll(() => request.mock.calls.length).toBe(1);
    hook.unmount();
    asked.resolve({ release } as unknown as WakeLockSentinel);
    await expect.poll(() => release.mock.calls.length).toBe(1);
  });

  it("wakes Director's sound when the member comes back or touches the screen", async () => {
    // The Start shooting tap: sound may start from it.
    await userEvent.click(document.body);
    const context = liveAudio();
    await expect.poll(() => context.state).toBe("running");
    const hook = await renderHook(() => useWakeAudio());
    // While hidden, a sleeping context stays asleep: iOS wouldn't let it run anyway.
    const asleep = async () => {
      const changed = new Promise((resolve) =>
        context.addEventListener("statechange", resolve, { once: true }),
      );
      await context.suspend();
      await changed;
      expect(context.state).toBe("suspended");
    };
    // The phone locked: hidden, iOS puts the sound to sleep; unlocked, it's woken.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await asleep();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => context.state).toBe("running");
    // A call came in, and ended: the next touch wakes it.
    visibility.mockReturnValue("hidden");
    await asleep();
    visibility.mockReturnValue("visible");
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await expect.poll(() => context.state).toBe("running");
    hook.unmount();
    restLiveAudio();
    await expect.poll(() => context.state).toBe("suspended");
  });

  it("copes with a refused lock, and a browser without one", async () => {
    const request = vi
      .spyOn(navigator.wakeLock, "request")
      .mockRejectedValue(new DOMException("battery saver", "NotAllowedError"));
    const refused = await renderHook(() => useWakeLock());
    await expect.poll(() => request.mock.calls.length).toBe(1);
    refused.unmount();
    const wakeLock = Object.getOwnPropertyDescriptor(Navigator.prototype, "wakeLock");
    Reflect.deleteProperty(Navigator.prototype, "wakeLock");
    try {
      const none = await renderHook(() => useWakeLock());
      none.unmount();
    } finally {
      if (wakeLock) {
        Object.defineProperty(Navigator.prototype, "wakeLock", wakeLock);
      }
    }
  });
});
