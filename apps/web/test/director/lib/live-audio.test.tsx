/** Director's sound context: one for the page, kept awake while the shoot screen uses it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { liveAudio, restLiveAudio, wakeLiveAudio } from "@/modules/director/lib/live-audio";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Director's sound", () => {
  it("wakes by itself when the browser puts it to sleep in view, and stays at rest once left", async () => {
    // No context yet: waking makes none (only the Start shooting tap may).
    wakeLiveAudio();
    await userEvent.click(document.body);
    const context = liveAudio();
    expect(liveAudio()).toBe(context);
    await expect.poll(() => context.state).toBe("running");
    // iOS suspends it for a call while the page stays in view: it runs again by itself.
    await context.suspend();
    await expect.poll(() => context.state).toBe("running");
    // The shoot screen left: at rest, and a tap elsewhere doesn't wake it.
    const resume = vi.spyOn(context, "resume");
    restLiveAudio();
    await expect.poll(() => context.state).toBe("suspended");
    wakeLiveAudio();
    expect(resume).not.toHaveBeenCalled();
    // Back on the shoot screen.
    liveAudio();
    await expect.poll(() => context.state).toBe("running");
  });

  it("waits for a tap when the browser won't wake it", async () => {
    const context = liveAudio();
    await expect.poll(() => context.state).toBe("running");
    const resume = vi
      .spyOn(context, "resume")
      .mockRejectedValue(new DOMException("needs a gesture", "NotAllowedError"));
    await context.suspend();
    await expect.poll(() => resume.mock.calls.length).toBeGreaterThan(0);
    expect(context.state).toBe("suspended");
    resume.mockRestore();
    wakeLiveAudio();
    await expect.poll(() => context.state).toBe("running");
  });
});
