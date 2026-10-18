/** The shoot screen's small hooks: what Director remembers, and keeping the screen awake. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemory } from "@/modules/director/hooks/use-memory";
import { useWakeLock } from "@/modules/director/hooks/use-screen";
import { FRESH } from "@/modules/director/lib/memory";
import { signUp } from "../users";
import { renderHook } from "./support";

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
