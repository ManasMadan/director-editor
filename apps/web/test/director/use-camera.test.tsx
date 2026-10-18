import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "@/modules/director/hooks/use-camera";
import { cameraStream, deferred, fakeCamera, renderHook } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

const ended = (stream: MediaStream | null) =>
  stream?.getTracks().every((track) => track.readyState === "ended");

describe("useCamera", () => {
  it("stays off until started, then opens the selfie camera, and closes it with the screen", async () => {
    const getUserMedia = fakeCamera();
    const hook = await renderHook(() => useCamera(true), {
      view: (camera) => <video ref={camera.video} muted />,
    });
    expect(hook.current.state).toBe("off");
    expect(getUserMedia).not.toHaveBeenCalled();
    hook.current.start();
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
    const hook = await renderHook(() => useCamera(false));
    hook.current.start();
    await expect.poll(() => hook.current.state).toBe("live");
    const first = hook.current.stream;

    hook.current.start();
    await expect.poll(() => hook.current.stream).not.toBe(first);
    expect(ended(first)).toBe(true);
    expect(ended(hook.current.stream)).toBe(false);
    expect(hook.current.state).toBe("live");
  });

  it("says when the camera was refused, and when there is none", async () => {
    const cases: [() => Promise<MediaStream>, string][] = [
      [() => Promise.reject(new DOMException("Permission denied", "NotAllowedError")), "blocked"],
      [() => Promise.reject(new DOMException("No camera", "NotFoundError")), "missing"],
      [() => Promise.reject(new TypeError("mediaDevices is undefined")), "missing"],
    ];
    for (const [answer, state] of cases) {
      fakeCamera(answer);
      const hook = await renderHook(() => useCamera(false));
      hook.current.start();
      await expect.poll(() => hook.current.state).toBe(state);
      hook.unmount();
    }
  });

  it("stops a stream that arrives after the screen has gone", async () => {
    const asked = deferred<MediaStream>();
    const getUserMedia = fakeCamera(() => asked.promise);
    const hook = await renderHook(() => useCamera(false));
    hook.current.start();
    await expect.poll(() => getUserMedia.mock.calls.length).toBe(1);
    hook.unmount();
    const late = cameraStream();
    asked.resolve(late);
    await expect.poll(() => ended(late)).toBe(true);
  });

  it("ignores a refusal that arrives after the screen has gone", async () => {
    const asked = deferred<MediaStream>();
    fakeCamera(() => asked.promise);
    const hook = await renderHook(() => useCamera(false));
    hook.current.start();
    await expect.poll(() => hook.current.state).toBe("starting");
    hook.unmount();
    asked.reject(new DOMException("denied", "NotAllowedError"));
    await expect(asked.promise).rejects.toThrow("denied");
    expect(hook.current.state).toBe("starting");
  });

  it("flips between the cameras, or faces the one asked for, reopening on that side", async () => {
    const getUserMedia = fakeCamera();
    const hook = await renderHook(() => useCamera(false));
    hook.current.start();
    await expect.poll(() => hook.current.state).toBe("live");
    hook.current.flip();
    await expect.poll(() => hook.current.facing).toBe("back");
    await expect
      .poll(() => getUserMedia.mock.calls.at(-1)?.[0])
      .toEqual(
        expect.objectContaining({ video: expect.objectContaining({ facingMode: "environment" }) }),
      );
    hook.current.face("front");
    await expect.poll(() => hook.current.facing).toBe("front");
    await expect.poll(() => getUserMedia.mock.calls.length).toBe(3);
    // Flipping twice comes back to the back camera.
    hook.current.flip();
    await expect.poll(() => hook.current.facing).toBe("back");
    hook.current.flip();
    await expect.poll(() => hook.current.facing).toBe("front");
  });

  it("closes the camera before opening the other, for phones that can't hold two open", async () => {
    // Many Android phones refuse a second camera while the first is still open.
    const open: MediaStream[] = [];
    fakeCamera(async () => {
      if (open.some((stream) => !ended(stream))) {
        throw new DOMException("Could not start video source", "NotReadableError");
      }
      const stream = cameraStream();
      open.push(stream);
      return stream;
    });
    const hook = await renderHook(() => useCamera(false));
    hook.current.start();
    await expect.poll(() => hook.current.state).toBe("live");
    const front = hook.current.stream;
    hook.current.flip();
    await expect.poll(() => hook.current.stream).not.toBe(front);
    expect(hook.current.state).toBe("live");
    expect(ended(front)).toBe(true);
    hook.unmount();
  });
});
