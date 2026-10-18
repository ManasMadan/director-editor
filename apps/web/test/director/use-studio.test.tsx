import type { DirectorTake, FileInfo } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "@/modules/director/hooks/use-camera";
import {
  nextPage,
  type StudioShot,
  shotPage,
  type TakeEvents,
  useStudio,
} from "@/modules/director/hooks/use-studio";
import { FakeRecorder, fakeCamera, id, renderHook, shot, standIn, until } from "./support";

const VIDEO_ID = "dQw4w9WgXcQ";
const STORAGE_URL = "http://storage.test/uploads/take";

beforeEach(() => {
  FakeRecorder.last = null;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  fakeCamera();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = (status: FileInfo["status"], purpose: FileInfo["purpose"]): FileInfo => ({
  id: fileIdSchema.parse(id(7)),
  purpose,
  status,
  filename: "take",
  contentType: null,
  size: null,
  rejectReason: null,
  createdAt: new Date(0),
});

/** Director's side of sending a take: the upload, storage's PUT and the new take. */
function director({ refuse = false } = {}) {
  const uploads: { purpose: string; filename: string; contentType: string; size: number }[] = [];
  const added: { videoId: string; shotIndex: number; kind: string; fileId: string }[] = [];
  const api = standIn((os) => ({
    files: {
      createUpload: os.files.createUpload.handler(({ input, errors }) => {
        if (refuse) {
          throw errors.FILE_TOO_LARGE({ data: { params: {} } });
        }
        uploads.push(input);
        return {
          file: file("pending", input.purpose),
          upload: {
            url: STORAGE_URL,
            headers: { "Content-Type": input.contentType },
            expiresAt: new Date(Date.now() + 60_000),
          },
        };
      }),
      completeUpload: os.files.completeUpload.handler(() => file("ready", "director-take-video")),
    },
    director: {
      addTake: os.director.addTake.handler(({ input }): DirectorTake => {
        added.push(input);
        return {
          id: directorTakeIdSchema.parse(id(8)),
          shotIndex: input.shotIndex,
          fileId: input.fileId,
          kind: input.kind,
          status: "pending",
          error: null,
          bestStartMs: null,
          bestEndMs: null,
          score: null,
          feedback: null,
          reason: null,
          chosen: false,
          origin: "shoot",
          createdAt: new Date(0),
        };
      }),
    },
  }));
  // Storage takes the bytes; everything else goes where it was going.
  const realFetch = window.fetch.bind(window);
  const stored = vi
    .spyOn(window, "fetch")
    .mockImplementation((input, init) =>
      String(input) === STORAGE_URL
        ? Promise.resolve(new Response(null, { status: 200 }))
        : realFetch(input, init),
    );
  return { api, uploads, added, stored };
}

/** The camera (opened at once) and the studio over it, as the shoot screen wires them. */
function useShootStudio(studio: StudioShot, events: TakeEvents) {
  const camera = useCamera(studio.audio === "voice");
  return { camera, ...useStudio(studio, camera, events) };
}

type Studio = ReturnType<typeof useShootStudio>;

const takeEvents = () => ({
  onCountdown: vi.fn(),
  onCancelled: vi.fn(),
  onRecording: vi.fn(),
  onRecorded: vi.fn(),
  onDiscarded: vi.fn(),
  onKept: vi.fn(),
});

/** The studio on the shoot page, its viewfinder on screen (or not, with `viewfinder: false`). */
async function renderStudio(
  studio: StudioShot,
  api: ReturnType<typeof director>["api"],
  { viewfinder = true, events = takeEvents() } = {},
) {
  const hook = await renderHook(() => useShootStudio(studio, events), {
    api,
    url: `/director/${VIDEO_ID}/shoot`,
    view: (value: Studio) => (viewfinder ? <video ref={value.camera.video} muted /> : null),
  });
  hook.current.camera.start();
  return Object.assign(hook, { events });
}

/** Moves the clock on a tenth of a second at a time until `check` passes. */
const ticking = (check: () => void) =>
  until(() => {
    vi.advanceTimersByTime(100);
    check();
  });

const clock = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });

describe("useStudio", () => {
  it("films a video: a countdown, the take until a moment past the shot, then the next shot", async () => {
    const { api, uploads, added } = director();
    const hook = await renderStudio(
      { videoId: VIDEO_ID, shot: shot({ durationSeconds: 1 }), index: 0, count: 2, audio: "voice" },
      api,
    );
    await until(() => expect(hook.current.camera.state).toBe("live"));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true }) }),
    );
    expect([hook.current.phase, hook.current.take, hook.current.failed]).toEqual([
      "setup",
      null,
      false,
    ]);

    clock();
    hook.current.actions.shutter();
    await until(() =>
      expect([hook.current.phase, hook.current.countdown]).toEqual(["countdown", 3]),
    );
    await ticking(() => expect(hook.current.phase).toBe("recording"));
    expect(hook.events.onRecording).toHaveBeenCalledOnce();
    expect(FakeRecorder.last?.stream).toBe(hook.current.camera.stream);
    await ticking(() => expect(hook.current.seconds).toBeGreaterThanOrEqual(2));
    expect(hook.current.phase).toBe("recording");
    await ticking(() => expect(hook.current.phase).toBe("preview"));
    expect(FakeRecorder.last?.state).toBe("inactive");
    expect(hook.current.seconds).toBe(0);
    expect(hook.current.take?.type).toBe("video/webm");
    expect(hook.events.onRecorded).toHaveBeenCalledOnce();
    vi.useRealTimers();

    hook.current.actions.use();
    await until(() => expect(hook.current.phase).toBe("sending"));
    // Sent: the take is let go, and the screen moves on.
    await until(() => expect(hook.events.onKept).toHaveBeenCalledOnce());
    await until(() => expect([hook.current.phase, hook.current.take]).toEqual(["setup", null]));
    expect(uploads).toEqual([
      {
        purpose: "director-take-video",
        filename: "shot-1.webm",
        contentType: "video/webm",
        size: 4,
      },
    ]);
    expect(added).toEqual([{ videoId: VIDEO_ID, shotIndex: 0, kind: "video", fileId: id(7) }]);
  });

  it("takes a photo, and goes to the takes after the last shot", async () => {
    const { api, uploads, added, stored } = director();
    const hook = await renderStudio(
      {
        videoId: VIDEO_ID,
        shot: shot({ kind: "photo" }),
        index: 1,
        count: 2,
        audio: "voice",
      },
      api,
    );
    await until(() => expect(hook.current.camera.state).toBe("live"));

    clock();
    hook.current.actions.shutter();
    await ticking(() => expect(hook.current.phase).toBe("preview"));
    expect(hook.current.take?.type).toBe("image/jpeg");
    vi.useRealTimers();

    expect(hook.events.onRecorded).toHaveBeenCalledOnce();
    hook.current.actions.use();
    await until(() => expect(hook.events.onKept).toHaveBeenCalledOnce());
    expect(uploads).toMatchObject([
      { purpose: "director-take-photo", filename: "shot-2.jpg", contentType: "image/jpeg" },
    ]);
    expect(added).toMatchObject([{ shotIndex: 1, kind: "photo" }]);
    expect(stored).toHaveBeenCalledWith(STORAGE_URL, expect.objectContaining({ method: "PUT" }));
  });

  it("goes on from a kept take to the next shot, the edit after the last, or back to the editor", () => {
    const at = { videoId: VIDEO_ID, count: 3, audio: "voice" as const };
    expect(nextPage({ ...at, index: 0 })).toBe(`/director/${VIDEO_ID}/shoot?shot=1&audio=voice`);
    expect(nextPage({ ...at, index: 2 })).toBe(`/director/${VIDEO_ID}/edit?audio=voice&wrap=1`);
    expect(nextPage({ ...at, index: 0, retake: true })).toBe(
      `/director/${VIDEO_ID}/edit?audio=voice`,
    );
  });

  it("names a shot's page, and keeps a retake's way back to the editor", () => {
    expect(shotPage(VIDEO_ID, 2, "voice")).toBe(`/director/${VIDEO_ID}/shoot?shot=2&audio=voice`);
    expect(shotPage(VIDEO_ID, 2, "voice", true)).toBe(
      `/director/${VIDEO_ID}/shoot?shot=2&audio=voice&back=edit`,
    );
  });

  it("sends a photo the browser could only make a PNG of as a PNG", async () => {
    // A browser without a JPEG encoder gives a PNG instead, as canvas.toBlob is specified.
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
      done(new Blob(["png"], { type: "image/png" })),
    );
    const { api, uploads } = director();
    const hook = await renderStudio(
      { videoId: VIDEO_ID, shot: shot({ kind: "photo" }), index: 0, count: 2, audio: "original" },
      api,
    );
    clock();
    hook.current.actions.shutter();
    await ticking(() => expect(hook.current.phase).toBe("preview"));
    vi.useRealTimers();
    hook.current.actions.use();
    await until(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({ purpose: "director-take-photo", contentType: "image/png" });
    expect(uploads[0]?.filename).toMatch(/^shot-1\./);
  });

  it("goes back to setup, saying so, when there's nothing to take the shot with", async () => {
    const { api } = director();
    const photo = await renderStudio(
      { videoId: VIDEO_ID, shot: shot({ kind: "photo" }), index: 0, count: 1, audio: "original" },
      api,
      { viewfinder: false },
    );
    clock();
    photo.current.actions.shutter();
    await ticking(() => expect(photo.current.failed).toBe(true));
    expect(photo.current.phase).toBe("setup");
    // Trying again clears it.
    photo.current.actions.shutter();
    await until(() =>
      expect([photo.current.phase, photo.current.failed]).toEqual(["countdown", false]),
    );
    photo.unmount();
    vi.useRealTimers();

    vi.stubGlobal("MediaRecorder", undefined);
    const video = await renderStudio(
      { videoId: VIDEO_ID, shot: shot(), index: 0, count: 1, audio: "original" },
      api,
    );
    await until(() => expect(video.current.camera.state).toBe("live"));
    clock();
    video.current.actions.shutter();
    await ticking(() => expect(video.current.failed).toBe(true));
    expect(video.current.phase).toBe("setup");
  });

  it("stops when asked, keeps the take when sending fails, and starts over on a retake", async () => {
    const { api } = director({ refuse: true });
    const hook = await renderStudio(
      {
        videoId: VIDEO_ID,
        shot: shot({ durationSeconds: 30 }),
        index: 0,
        count: 1,
        audio: "voice",
      },
      api,
    );
    await until(() => expect(hook.current.camera.state).toBe("live"));
    // Nothing to send yet.
    hook.current.actions.use();
    expect(hook.current.phase).toBe("setup");

    clock();
    hook.current.actions.shutter();
    await ticking(() => expect(hook.current.phase).toBe("recording"));
    vi.useRealTimers();
    hook.current.actions.shutter();
    await until(() => expect(hook.current.phase).toBe("preview"));
    // The shutter does nothing while the take is being watched back.
    hook.current.actions.shutter();
    expect(hook.current.phase).toBe("preview");

    hook.current.actions.use();
    await until(() => expect(hook.current.submit.error).not.toBeNull());
    expect(hook.current.phase).toBe("preview");
    expect(hook.current.take).not.toBeNull();
    expect(api.calls).toEqual(["files/createUpload"]);

    hook.current.actions.again();
    await until(() =>
      expect([hook.current.phase, hook.current.take, hook.current.submit.error]).toEqual([
        "setup",
        null,
        null,
      ]),
    );
    expect(hook.events.onDiscarded).toHaveBeenCalledOnce();
  });

  it("calls the countdown off from the shutter or Escape, and never records then", async () => {
    const { api } = director();
    const hook = await renderStudio(
      { videoId: VIDEO_ID, shot: shot(), index: 0, count: 1, audio: "voice" },
      api,
    );
    await until(() => expect(hook.current.camera.state).toBe("live"));
    clock();
    hook.current.actions.shutter();
    await until(() => expect(hook.current.countdown).toBe(3));
    hook.current.actions.shutter();
    await until(() =>
      expect([hook.current.phase, hook.current.countdown]).toEqual(["setup", null]),
    );
    hook.current.actions.shutter();
    await until(() => expect(hook.current.phase).toBe("countdown"));
    // Another key changes nothing; Escape calls it off.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(hook.current.phase).toBe("countdown");
    await until(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(hook.current.phase).toBe("setup");
    });
    vi.advanceTimersByTime(5000);
    expect(FakeRecorder.last).toBeNull();
    expect(hook.events.onRecording).not.toHaveBeenCalled();
    // Director heard each count start, and each one called off.
    expect(hook.events.onCountdown).toHaveBeenCalledTimes(2);
    expect(hook.events.onCancelled).toHaveBeenCalledTimes(2);
  });

  it("halts a take where it is: the count called off, the recording stopped and kept on screen", async () => {
    const { api } = director();
    const hook = await renderStudio(
      {
        videoId: VIDEO_ID,
        shot: shot({ durationSeconds: 30 }),
        index: 0,
        count: 1,
        audio: "voice",
      },
      api,
    );
    await until(() => expect(hook.current.camera.state).toBe("live"));
    // Nothing to halt yet.
    hook.current.actions.halt();
    expect(hook.current.phase).toBe("setup");
    clock();
    hook.current.actions.shutter();
    await until(() => expect(hook.current.phase).toBe("countdown"));
    hook.current.actions.halt();
    await until(() => expect(hook.current.phase).toBe("setup"));
    hook.current.actions.shutter();
    await ticking(() => expect(hook.current.phase).toBe("recording"));
    vi.useRealTimers();
    hook.current.actions.halt();
    await until(() => expect(hook.current.phase).toBe("preview"));
    expect(hook.current.take).not.toBeNull();
  });
});
