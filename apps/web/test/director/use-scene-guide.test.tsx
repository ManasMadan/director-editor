import type { SceneCheck } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSceneGuide } from "@/modules/director/hooks/use-scene-guide";
import { cameraVideo, deferred, renderHook, standIn, until } from "./support";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const VIDEO_ID = "dQw4w9WgXcQ";

const direction = (n: number, inPlace = false): SceneCheck => ({
  inPlace,
  instruction: `Direction ${n}`,
  direction: inPlace ? "none" : "left",
  distanceMeters: inPlace ? null : 2,
  landmark: null,
  lighting: "good",
});

/** Director's answers, one per check, from `answer` (the check's number, from 1). */
function director(answer: (n: number) => Promise<SceneCheck> | SceneCheck = direction) {
  const inputs: { videoId: string; shotIndex: number; image: string }[] = [];
  const api = standIn((os) => ({
    director: {
      checkScene: os.director.checkScene.handler(({ input }) => {
        inputs.push(input);
        return answer(inputs.length);
      }),
    },
  }));
  return { api, inputs };
}

const everySixSeconds = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

/**
 * Waits for the answer to check `n`, then moves the clock to the next one. A tick while
 * that check is still settling is skipped, so the clock moves until the next one goes out
 * (`asked` is how many have).
 */
async function nextCheck(
  hook: { current: { scene: SceneCheck | null } },
  n: number,
  asked?: () => number,
) {
  await until(() => expect(hook.current.scene?.instruction).toBe(`Direction ${n}`));
  if (!asked) {
    vi.advanceTimersByTime(6_000);
    return;
  }
  // A real frame and answer each time: on a busy runner one can take a few seconds.
  await until(() => {
    if (asked() <= n) {
      vi.advanceTimersByTime(6_000);
    }
    expect(asked()).toBeGreaterThan(n);
  }, 15_000);
}

describe("useSceneGuide", () => {
  it("checks the camera's view at once, then every six seconds until you're there", async () => {
    everySixSeconds();
    const { api, inputs } = director((n) => direction(n, n === 3));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 2, active: true, moved: 0 }),
      { api },
    );
    await nextCheck(hook, 1);
    // Not there yet, with checks to spare: Gemini is guiding the walk.
    expect(hook.current.guiding).toBe(true);
    expect(inputs[0]).toMatchObject({ videoId: VIDEO_ID, shotIndex: 2 });
    // The frame, a JPEG in base64.
    expect(atob(inputs[0]?.image ?? "").startsWith("\xff\xd8\xff")).toBe(true);
    await nextCheck(hook, 2);
    await until(() => expect(hook.current.scene).toEqual(direction(3, true)));

    // In place: it stops looking.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(inputs).toHaveLength(3);
    expect(hook.current.offline).toBe(false);
    // There: nothing left to walk to.
    expect(hook.current.guiding).toBe(false);
  });

  it("looks only while active", async () => {
    everySixSeconds();
    const { api, inputs } = director();
    const video = { current: cameraVideo() };
    let active = false;
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active, moved: 0 }),
      { api },
    );
    vi.advanceTimersByTime(20_000);
    expect(inputs).toHaveLength(0);

    active = true;
    hook.rerender();
    await nextCheck(hook, 1);
    active = false;
    hook.rerender();
    expect(vi.getTimerCount()).toBe(0);
    // The last direction stays.
    expect(hook.current.scene?.instruction).toBe("Direction 1");
  });

  it("tries again after a check that failed, and guides on the device after two in a row", async () => {
    everySixSeconds();
    let failing = 1;
    let asked = 0;
    const api = standIn((os) => ({
      director: {
        checkScene: os.director.checkScene.handler(({ errors }) => {
          asked += 1;
          if (asked <= failing) {
            throw errors.UPSTREAM_UNAVAILABLE({ data: { params: {} } });
          }
          return direction(asked);
        }),
      },
    }));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    await until(() => expect(asked).toBe(1));
    expect(hook.current.scene).toBeNull();
    // A tick while the failed check is still settling is skipped: the clock moves until
    // the next one goes out.
    await until(() => {
      vi.advanceTimersByTime(6_000);
      expect(asked).toBe(2);
    });
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 2"));
    expect(hook.current.offline).toBe(false);

    // Two misses in a row: Gemini is out of reach, and it stops asking.
    failing = 4;
    vi.advanceTimersByTime(6_000);
    await until(() => expect(asked).toBe(3));
    await until(() => {
      vi.advanceTimersByTime(6_000);
      expect(hook.current.offline).toBe(true);
    });
    // Out of reach: its last direction no longer guides the walk.
    expect(hook.current.guiding).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(asked).toBe(4);
  });

  it("looks again at once when the camera is pointed somewhere new", async () => {
    everySixSeconds();
    const { api, inputs } = director();
    const video = { current: cameraVideo() };
    let moved = 0;
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved }),
      { api },
    );
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 1"));
    // Too soon after the last look: it waits.
    moved = 1;
    hook.rerender();
    expect(inputs).toHaveLength(1);
    clock.mockReturnValue(4_000);
    moved = 2;
    hook.rerender();
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 2"));
  });

  it("waits for an answer before asking again", async () => {
    everySixSeconds();
    const slow = deferred<SceneCheck>();
    const { api, inputs } = director((n) => (n === 1 ? slow.promise : direction(n)));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    await until(() => expect(inputs).toHaveLength(1));
    vi.advanceTimersByTime(15_000);
    slow.resolve(direction(1));
    await nextCheck(hook, 1);
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 2"));
    expect(inputs).toHaveLength(2);
  });

  it("spends nothing, and doesn't count Gemini out, when the camera can't give a frame", async () => {
    everySixSeconds();
    const { api, inputs } = director();
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const empty = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((done) => done(null));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    // Each tick looks again once the last look has settled.
    await until(() => {
      vi.advanceTimersByTime(6_000);
      expect(empty.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(inputs).toHaveLength(0);
    expect(hook.current.offline).toBe(false);
    empty.mockImplementation(function (this: HTMLCanvasElement, ...args) {
      toBlob.apply(this, args);
    });
    await until(() => {
      vi.advanceTimersByTime(6_000);
      expect(hook.current.scene?.instruction).toBe("Direction 1");
    });
  });

  it("sends nothing for a frame it was still taking when the screen went away", async () => {
    const { api, inputs } = director();
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const frames: (() => void)[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      ...args
    ) {
      frames.push(() => toBlob.apply(this, args));
    });
    const video = { current: cameraVideo() };
    const gone = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    await until(() => expect(frames).toHaveLength(1));
    gone.unmount();
    frames[0]?.();

    // A screen still open sends its frame, which went the same way after it: once its
    // check is in, the one from the screen that went had every chance to arrive first.
    const open = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 1, active: true, moved: 0 }),
      { api },
    );
    await until(() => expect(frames).toHaveLength(2));
    frames[1]?.();
    await until(() => expect(open.current.scene).not.toBeNull());
    expect(inputs.map((input) => input.shotIndex)).toEqual([1]);
  });

  it("skips a check with no frame to send, or with the page hidden", async () => {
    everySixSeconds();
    const { api, inputs } = director();
    const video: { current: HTMLVideoElement | null } = { current: null };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    video.current = cameraVideo({ readyState: 1 });
    vi.advanceTimersByTime(6_000);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    video.current = cameraVideo();
    vi.advanceTimersByTime(6_000);
    expect(inputs).toHaveLength(0);

    hidden.mockReturnValue(false);
    vi.advanceTimersByTime(6_000);
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 1"));
  });

  // Sixteen real frames and answers: past the default 30 seconds on a busy runner.
  it("gives up after sixteen checks, so a camera left on stops spending", {
    timeout: 90_000,
  }, async () => {
    everySixSeconds();
    const { api, inputs } = director();
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true, moved: 0 }),
      { api },
    );
    for (let n = 1; n < 16; n++) {
      await nextCheck(hook, n, () => inputs.length);
    }
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 16"));
    // Its checks spent, it no longer guides the walk.
    expect(hook.current.guiding).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(inputs).toHaveLength(16);
  });
});
