/**
 * Director's sound context made ahead of the "Start shooting" tap (its own file: the
 * page's one context must not exist yet when the test starts).
 */
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { liveAudio, prepareLiveAudio, wakeLiveAudio } from "@/modules/director/lib/live-audio";

it("is made ahead and asleep, woken by the Start shooting tap and not by any other", async () => {
  const listened = vi.spyOn(AudioContext.prototype, "addEventListener");
  const resume = vi.spyOn(AudioContext.prototype, "resume");
  prepareLiveAudio();
  prepareLiveAudio();
  expect(listened).toHaveBeenCalledTimes(1);
  const prepared = listened.mock.contexts[0];
  // A tap elsewhere on the screen before Start leaves it asleep.
  await userEvent.click(document.body);
  wakeLiveAudio();
  expect(resume).not.toHaveBeenCalled();
  // The Start tap uses the one made ahead, and wakes it.
  const context = liveAudio();
  expect(context).toBe(prepared);
  await expect.poll(() => context.state).toBe("running");
  // Put to sleep by the browser while it's wanted, it runs again by itself.
  await context.suspend();
  await expect.poll(() => context.state).toBe("running");
});
