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

const everyFiveSeconds = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

/** Waits for the answer to check `n`, then moves the clock to the next one. */
async function nextCheck(hook: { current: { scene: SceneCheck | null } }, n: number) {
  await until(() => expect(hook.current.scene?.instruction).toBe(`Direction ${n}`));
  vi.advanceTimersByTime(5_000);
}

describe("useSceneGuide", () => {
  it("checks the camera's view at once, then every five seconds until you're there", async () => {
    everyFiveSeconds();
    const { api, inputs } = director((n) => direction(n, n === 3));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 2, active: true }),
      { api },
    );
    await nextCheck(hook, 1);
    expect(inputs[0]).toMatchObject({ videoId: VIDEO_ID, shotIndex: 2 });
    // The frame, a JPEG in base64.
    expect(atob(inputs[0]?.image ?? "").startsWith("\xff\xd8\xff")).toBe(true);
    await nextCheck(hook, 2);
    await until(() => expect(hook.current.scene).toEqual(direction(3, true)));

    // In place: it stops looking.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(inputs).toHaveLength(3);
    expect(hook.current.error).toBeNull();
  });

  it("looks only while active", async () => {
    everyFiveSeconds();
    const { api, inputs } = director();
    const video = { current: cameraVideo() };
    let active = false;
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active }),
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

  it("tries again after a check that failed", async () => {
    everyFiveSeconds();
    const api = standIn((os) => ({
      director: {
        checkScene: os.director.checkScene.handler(({ errors }) => {
          if (api.calls.length === 1) {
            throw errors.UPSTREAM_UNAVAILABLE({ data: { params: {} } });
          }
          return direction(2);
        }),
      },
    }));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true }),
      { api },
    );
    await until(() => expect(hook.current.error?.message).toBeTruthy());
    expect(hook.current.scene).toBeNull();
    vi.advanceTimersByTime(5_000);
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 2"));
    expect(hook.current.error).toBeNull();
  });

  it("waits for an answer before asking again", async () => {
    everyFiveSeconds();
    const slow = deferred<SceneCheck>();
    const { api, inputs } = director((n) => (n === 1 ? slow.promise : direction(n)));
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true }),
      { api },
    );
    await until(() => expect(inputs).toHaveLength(1));
    vi.advanceTimersByTime(15_000);
    slow.resolve(direction(1));
    await nextCheck(hook, 1);
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 2"));
    expect(inputs).toHaveLength(2);
  });

  it("skips a check with no frame to send, or with the page hidden", async () => {
    everyFiveSeconds();
    const { api, inputs } = director();
    const video: { current: HTMLVideoElement | null } = { current: null };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true }),
      { api },
    );
    video.current = cameraVideo({ readyState: 1 });
    vi.advanceTimersByTime(5_000);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    video.current = cameraVideo();
    vi.advanceTimersByTime(5_000);
    expect(inputs).toHaveLength(0);

    hidden.mockReturnValue(false);
    vi.advanceTimersByTime(5_000);
    await until(() => expect(hook.current.scene?.instruction).toBe("Direction 1"));
  });

  it("gives up after a dozen checks, so a camera left on stops spending", async () => {
    everyFiveSeconds();
    const { api, inputs } = director();
    const video = { current: cameraVideo() };
    const hook = await renderHook(
      () => useSceneGuide(video, { videoId: VIDEO_ID, shotIndex: 0, active: true }),
      { api },
    );
    for (let n = 1; n <= 12; n++) {
      await nextCheck(hook, n);
    }
    vi.advanceTimersByTime(30_000);
    expect(inputs).toHaveLength(12);
  });
});
