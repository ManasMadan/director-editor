import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTakeRecorder } from "@/modules/director/hooks/use-take-recorder";
import { FakeRecorder, renderHook, until } from "./support";

beforeEach(() => {
  FakeRecorder.last = null;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const recorder = () => {
  if (!FakeRecorder.last) {
    throw new Error("no recorder was made");
  }
  return FakeRecorder.last;
};

describe("useTakeRecorder", () => {
  it("records the camera into a take, counting the seconds while it runs", async () => {
    const stream = new MediaStream();
    const hook = await renderHook(() => useTakeRecorder(stream));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    expect(hook.current.start()).toBe(true);
    expect(recorder()).toMatchObject({
      stream,
      state: "recording",
      timeslice: 500,
      options: { mimeType: "video/webm;codecs=vp9,opus", videoBitsPerSecond: 1_500_000 },
    });
    await until(() => expect(hook.current.recording).toBe(true));
    await until(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(2_500);
    await until(() => expect(hook.current.seconds).toBe(2.5));

    hook.current.stop();
    await until(() => expect(hook.current.recording).toBe(false));
    expect(hook.current.take?.type).toBe("video/webm");
    expect(await hook.current.take?.text()).toBe("take");
    expect(vi.getTimerCount()).toBe(0);
    // Stopping a recorder that isn't recording does nothing.
    hook.current.stop();

    hook.current.discard();
    await until(() => expect(hook.current.take).toBeNull());
  });

  it("starts each take afresh", async () => {
    const hook = await renderHook(() => useTakeRecorder(new MediaStream()));
    hook.current.start();
    hook.current.stop();
    await until(() => expect(hook.current.take).not.toBeNull());

    hook.current.start();
    await until(() => expect(hook.current.take).toBeNull());
    expect(hook.current.seconds).toBe(0);
    expect(hook.current.recording).toBe(true);
  });

  it("stops by itself at a minute", async () => {
    const hook = await renderHook(() => useTakeRecorder(new MediaStream()));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    hook.current.start();
    await until(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(59_900);
    expect(recorder().state).toBe("recording");
    vi.advanceTimersByTime(100);
    await until(() => expect(hook.current.take).not.toBeNull());
    expect(hook.current.seconds).toBe(60);
    expect(recorder().state).toBe("inactive");
  });

  it("stops the recorder when the screen goes mid-take", async () => {
    const hook = await renderHook(() => useTakeRecorder(new MediaStream()));
    hook.current.start();
    hook.unmount();
    expect(recorder().state).toBe("inactive");
  });

  it("records in MP4 where the browser does", async () => {
    vi.spyOn(FakeRecorder, "isTypeSupported").mockImplementation((type) => type === "video/mp4");
    const hook = await renderHook(() => useTakeRecorder(new MediaStream()));
    hook.current.start();
    hook.current.stop();
    await until(() => expect(hook.current.take?.type).toBe("video/mp4"));
    expect(recorder().options.mimeType).toBe("video/mp4");
  });

  it("can't start without a camera, or in a browser that can't record it", async () => {
    const noCamera = await renderHook(() => useTakeRecorder(null));
    expect(noCamera.current.start()).toBe(false);
    noCamera.unmount();

    const stream = new MediaStream();
    vi.spyOn(FakeRecorder, "isTypeSupported").mockReturnValue(false);
    const noFormat = await renderHook(() => useTakeRecorder(stream));
    expect(noFormat.current.start()).toBe(false);
    noFormat.unmount();
    vi.restoreAllMocks();

    vi.stubGlobal("MediaRecorder", undefined);
    const noRecorder = await renderHook(() => useTakeRecorder(stream));
    expect(noRecorder.current.start()).toBe(false);
    noRecorder.unmount();

    // The browser turns down the format it just said it records.
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeRecorder {
        constructor(stream: MediaStream, options: MediaRecorderOptions) {
          super(stream, options);
          throw new DOMException("Not supported", "NotSupportedError");
        }
      },
    );
    const refused = await renderHook(() => useTakeRecorder(stream));
    expect(refused.current.start()).toBe(false);
    expect(refused.current.recording).toBe(false);
  });
});
