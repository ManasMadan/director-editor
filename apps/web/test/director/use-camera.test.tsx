import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "@/modules/director/hooks/use-camera";
import { cameraStream, deferred, fakeCamera, renderHook } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

const ended = (stream: MediaStream | null) =>
  stream?.getTracks().every((track) => track.readyState === "ended");

describe("useCamera", () => {
  it("opens the shot's camera on the video, and closes it when the screen goes", async () => {
    const getUserMedia = fakeCamera();
    const hook = await renderHook(() => useCamera("front", true), {
      view: (camera) => <video ref={camera.video} muted />,
    });
    expect(hook.current.state).toBe("starting");
    await expect.poll(() => hook.current.state).toBe("live");
    const { stream } = hook.current;
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true }),
        video: expect.objectContaining({ facingMode: "user" }),
      }),
    );
    await expect.poll(() => hook.current.video.current?.srcObject).toBe(stream);
    expect(ended(stream)).toBe(false);

    hook.unmount();
    expect(ended(stream)).toBe(true);
  });

  it("swaps in a new stream when started again, closing the old one", async () => {
    fakeCamera();
    const hook = await renderHook(() => useCamera("back", false));
    await expect.poll(() => hook.current.state).toBe("live");
    const first = hook.current.stream;

    await hook.current.start();
    await expect.poll(() => hook.current.stream).not.toBe(first);
    expect(ended(first)).toBe(true);
    expect(ended(hook.current.stream)).toBe(false);
    expect(hook.current.state).toBe("live");
  });

  it("says when the camera was refused, and when there is none", async () => {
    fakeCamera(() => Promise.reject(new DOMException("Permission denied", "NotAllowedError")));
    const blocked = await renderHook(() => useCamera("back", false));
    await expect.poll(() => blocked.current.state).toBe("blocked");
    blocked.unmount();

    fakeCamera(() => Promise.reject(new DOMException("No camera", "NotFoundError")));
    const missing = await renderHook(() => useCamera("back", false));
    await expect.poll(() => missing.current.state).toBe("missing");
    missing.unmount();

    fakeCamera(() => Promise.reject(new TypeError("mediaDevices is undefined")));
    const insecure = await renderHook(() => useCamera("back", false));
    await expect.poll(() => insecure.current.state).toBe("missing");
  });

  it("stops a stream that arrives after the screen has gone", async () => {
    const answer = deferred<MediaStream>();
    const getUserMedia = fakeCamera(() => answer.promise);
    const hook = await renderHook(() => useCamera("back", true));
    await expect.poll(() => getUserMedia).toHaveBeenCalled();
    hook.unmount();
    const late = cameraStream();
    answer.resolve(late);
    await expect.poll(() => ended(late)).toBe(true);
    expect(hook.current.state).toBe("starting");
  });

  it("ignores a refusal that arrives after the screen has gone", async () => {
    const answer = deferred<MediaStream>();
    const getUserMedia = fakeCamera(() => answer.promise);
    const hook = await renderHook(() => useCamera("back", true));
    await expect.poll(() => getUserMedia).toHaveBeenCalled();
    hook.unmount();
    answer.reject(new DOMException("Permission denied", "NotAllowedError"));
    // The hook's handler was waiting first, so it has run by the time this one does.
    await answer.promise.catch(() => undefined);
    expect(hook.current.state).toBe("starting");
  });

  it("flips between the cameras, shows the screen, and goes back to the camera", async () => {
    const getUserMedia = fakeCamera();
    const screen = cameraStream();
    vi.spyOn(navigator.mediaDevices, "getDisplayMedia").mockResolvedValue(screen);
    const hook = await renderHook(() => useCamera("front", false));
    await expect.poll(() => hook.current.state).toBe("live");
    hook.current.flip();
    await expect.poll(() => hook.current.facing).toBe("back");
    hook.current.flip();
    await expect.poll(() => hook.current.facing).toBe("front");
    await expect.poll(() => getUserMedia.mock.calls.length).toBe(3);

    await hook.current.share?.();
    await expect.poll(() => hook.current.source).toBe("screen");
    expect(hook.current.stream).toBe(screen);
    hook.current.stopSharing();
    await expect.poll(() => hook.current.source).toBe("camera");
    expect(ended(screen)).toBe(true);
  });

  it("offers no screen sharing where the browser has none", async () => {
    fakeCamera();
    const own = Object.getOwnPropertyDescriptor(MediaDevices.prototype, "getDisplayMedia");
    Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia");
    try {
      const hook = await renderHook(() => useCamera("back", false));
      expect(hook.current.share).toBeNull();
    } finally {
      if (own) {
        Object.defineProperty(MediaDevices.prototype, "getDisplayMedia", own);
      }
    }
  });
});
