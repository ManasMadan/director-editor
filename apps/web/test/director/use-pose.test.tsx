import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePose } from "@/modules/director/hooks/use-pose";
import type { Body } from "@/modules/director/lib/pose";
import { createPoseDetector, type PoseDetector } from "@/modules/director/lib/pose-detector";
import { cameraVideo, deferred, renderHook, until } from "./support";

// MediaPipe's model comes from a CDN; the detector stands in for it.
vi.mock("@/modules/director/lib/pose-detector", () => ({ createPoseDetector: vi.fn() }));

/** A detector that finds `found` in every frame. */
function fakeDetector(found: Body | null = { nose: { x: 0.5, y: 0.25 } }) {
  const detector = {
    detect: vi.fn<PoseDetector["detect"]>(() => found),
    close: vi.fn(),
  };
  vi.mocked(createPoseDetector).mockResolvedValue(detector);
  return detector;
}

beforeEach(() => {
  vi.mocked(createPoseDetector).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const frames = () =>
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });

describe("usePose", () => {
  it("finds the person's joints a dozen times a second, in the viewfinder's space", async () => {
    frames();
    const detector = fakeDetector({ nose: { x: 0.5, y: 0.25 }, left_wrist: { x: 0.4, y: 0.5 } });
    // A laptop's landscape camera: the viewfinder is its middle 9:16.
    const video = { current: cameraVideo({ width: 1920, height: 1080 }) };
    const hook = await renderHook(() => usePose(video, true));
    await until(() => expect(hook.current.state).toBe("ready"));

    vi.advanceTimersByTime(80);
    expect(detector.detect).toHaveBeenCalledOnce();
    expect(detector.detect).toHaveBeenCalledWith(video.current, 80);
    await until(() => expect(hook.current.body?.nose).toEqual({ x: 0.5, y: 0.25 }));
    expect(hook.current.body?.left_wrist?.x).toBeCloseTo((0.4 * 1920 - 656.25) / 607.5);
    expect(hook.current.body?.left_wrist?.y).toBe(0.5);

    // Not again until 80ms have passed.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(48);
    expect(detector.detect).toHaveBeenCalledOnce();
    vi.advanceTimersToNextFrame();
    expect(detector.detect).toHaveBeenLastCalledWith(video.current, 160);
    expect(detector.detect).toHaveBeenCalledTimes(2);
  });

  it("finds nobody when nobody is there", async () => {
    frames();
    const detector = fakeDetector(null);
    const video = { current: cameraVideo() };
    const hook = await renderHook(() => usePose(video, true));
    await until(() => expect(hook.current.state).toBe("ready"));
    vi.advanceTimersByTime(80);
    expect(detector.detect).toHaveBeenCalledOnce();
    expect(hook.current.body).toBeNull();
  });

  it("waits for the camera's first frame", async () => {
    frames();
    const detector = fakeDetector();
    const video: { current: HTMLVideoElement | null } = { current: null };
    const hook = await renderHook(() => usePose(video, true));
    await until(() => expect(hook.current.state).toBe("ready"));
    vi.advanceTimersByTime(200);
    video.current = cameraVideo({ readyState: 1 });
    vi.advanceTimersByTime(200);
    expect(detector.detect).not.toHaveBeenCalled();

    video.current = cameraVideo();
    vi.advanceTimersByTime(100);
    expect(detector.detect).toHaveBeenCalled();
  });

  it("stays off until enabled, and lets go of the model when turned off", async () => {
    frames();
    const detector = fakeDetector();
    let enabled = false;
    const video = { current: cameraVideo() };
    const hook = await renderHook(() => usePose(video, enabled));
    expect(hook.current).toEqual({ body: null, state: "off" });
    expect(createPoseDetector).not.toHaveBeenCalled();

    enabled = true;
    hook.rerender();
    await until(() => expect(hook.current.state).toBe("ready"));
    vi.advanceTimersByTime(80);
    await until(() => expect(hook.current.body).not.toBeNull());

    enabled = false;
    hook.rerender();
    await until(() => expect(hook.current).toEqual({ body: null, state: "off" }));
    expect(detector.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a model that loads after the screen has gone", async () => {
    const loading = deferred<PoseDetector>();
    vi.mocked(createPoseDetector).mockReturnValue(loading.promise);
    const video = { current: cameraVideo() };
    const hook = await renderHook(() => usePose(video, true));
    await until(() => expect(createPoseDetector).toHaveBeenCalled());
    hook.unmount();
    const detector = { detect: vi.fn(), close: vi.fn() };
    loading.resolve(detector);
    await until(() => expect(detector.close).toHaveBeenCalledOnce());
    expect(hook.current.state).toBe("loading");
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it("says when the model couldn't load", async () => {
    vi.mocked(createPoseDetector).mockRejectedValue(new Error("offline"));
    const video = { current: cameraVideo() };
    const hook = await renderHook(() => usePose(video, true));
    await until(() => expect(hook.current.state).toBe("failed"));
    expect(hook.current.body).toBeNull();
  });
});
