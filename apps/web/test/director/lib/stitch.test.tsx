import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { CaptionInk } from "@/modules/director/lib/caption-draw";
import { recorderFormat } from "@/modules/director/lib/media";
import { IncompleteRender, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@/modules/director/lib/output";
import { lastFrameSeconds } from "@/modules/director/lib/recorded";
import { type Captions, type Segment, stitch } from "@/modules/director/lib/stitch";
import { photoOf, playedFrames, recordClip, recordToneClip, toneRuns } from "./footage";

const INK: CaptionInk = {
  text: "#ffffff",
  outline: "#000000",
  highlight: "#ff0000",
  box: "#000000",
};
const CAPTIONS: Captions = {
  lines: [{ startSeconds: 0, endSeconds: 0.25, text: "Hello there" }],
  style: "pop",
  ink: INK,
};
const FRAME = 1 / 30;

let clip: Blob;
let photo: Blob;
let audio: AudioContext;

beforeAll(async () => {
  // The render's clock is its AudioContext, which starts once the member has used the
  // page (the Save they tap).
  await userEvent.click(document.body);
  audio = new AudioContext();
  await audio.resume();
  clip = await recordClip(1, ["#ff0000", "#0000ff"]);
  photo = await photoOf("#00ff00");
  return () => audio.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The finished short's picture size, as a video element reads it. */
async function sizeOf(short: Blob) {
  const video = document.createElement("video");
  video.muted = true;
  const loaded = new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });
  video.src = URL.createObjectURL(short);
  await loaded;
  return [video.videoWidth, video.videoHeight];
}

/** The short's sound, decoded. */
async function soundOf(short: Blob) {
  const decoded = await audio.decodeAudioData(await short.arrayBuffer());
  return { samples: decoded.getChannelData(0), rate: decoded.sampleRate };
}

/** When the picture first turns `hue` after `from` seconds. */
const turns = (frames: { time: number; hue: string }[], hue: string, from: number) =>
  frames.find((frame) => frame.time >= from && frame.hue === hue)?.time;

/** When `tone` first sounds after `from` seconds. */
const sounds = (runs: ReturnType<typeof toneRuns>, tone: number | null, from: number) =>
  runs.find((run) => run.start >= from - 0.02 && run.tone === tone)?.start;

describe("stitching the short", () => {
  it("plays each take's part and each photo in order, captioned, into one 9:16 video", async () => {
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    const progress: number[] = [];
    const segments: Segment[] = [
      { kind: "video", source: clip, startSeconds: 0.1, endSeconds: 0.4 },
      { kind: "photo", source: photo, seconds: 0.3 },
      // Past the take's end: its last frame holds for the rest of its part.
      { kind: "video", source: clip, startSeconds: 0.7, endSeconds: 1.5 },
    ];
    const short = await stitch(segments, {
      audio,
      withSound: false,
      onProgress: (done) => progress.push(done),
      captions: CAPTIONS,
    });
    expect(short.type).toBe(recorderFormat()?.uploadType);
    expect(await sizeOf(short)).toEqual([OUTPUT_WIDTH, OUTPUT_HEIGHT]);
    // The caption's words, in capitals, while its line was on.
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["HELLO", "THERE"]),
    );
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.every((done) => done >= 0 && done <= 1)).toBe(true);
    expect(progress[0]).toBeLessThan(0.1);
    expect(progress.at(-1)).toBe(1);
    // As long as the edit (1.4 s), though the last part runs past its take's end: a take
    // that ran out used to end its part early, and the video came out shorter than the edit.
    const frames = await playedFrames(short);
    expect((frames.at(-1)?.time ?? 0) + FRAME).toBeGreaterThanOrEqual(1.4);
    expect(frames.find((frame) => frame.time > 1.2)?.hue).toBe("blue");
  });

  it("draws a part a match cut lined up moved and turned, and holds black before any picture", async () => {
    const rotate = vi.spyOn(CanvasRenderingContext2D.prototype, "rotate");
    const short = await stitch(
      [
        // A gap first: no picture yet, and nothing to hold.
        { kind: "gap", seconds: 0.2 },
        {
          kind: "video",
          source: clip,
          startSeconds: 0.1,
          endSeconds: 0.5,
          transform: { x: 20, y: 0, scale: 1.2, rotation: 3 },
        },
      ],
      { audio, withSound: false, onProgress: vi.fn(), captions: { ...CAPTIONS, style: "off" } },
    );
    expect(rotate).toHaveBeenCalledWith((3 * Math.PI) / 180);
    const frames = await playedFrames(short);
    expect(frames[0]?.hue).toBe("other");
    expect(frames.some((frame) => frame.hue === "red")).toBe(true);
  });

  it("keeps every cut's picture and sound together, sub-second parts and gaps too, with no frame held long", {
    timeout: 60_000,
  }, async () => {
    // Like the owner's shoot: a long take, takes kept for a tenth of a second or under
    // one, and shots left as gaps between them. Each take's picture and tone say which.
    const red = await recordToneClip(audio, 1.2, "#ff0000", 440);
    const blue = await recordToneClip(audio, 1, "#0000ff", 880);
    const green = await recordToneClip(audio, 1, "#00ff00", 1320);
    const segments: Segment[] = [
      { kind: "video", source: red, startSeconds: 0, endSeconds: 1 },
      { kind: "gap", seconds: 0.4 },
      { kind: "video", source: blue, startSeconds: 0.2, endSeconds: 0.3 },
      { kind: "gap", seconds: 0.3 },
      { kind: "video", source: green, startSeconds: 0.1, endSeconds: 0.8 },
      { kind: "video", source: blue, startSeconds: 0, endSeconds: 0.5 },
    ];
    const short = await stitch(segments, {
      audio,
      withSound: true,
      onProgress: vi.fn(),
      captions: { ...CAPTIONS, style: "off" },
    });
    const frames = await playedFrames(short);
    const { samples, rate } = await soundOf(short);
    const runs = toneRuns(samples, rate, [440, 880, 1320]);
    // Every frame follows the one before at the frame rate: a held picture (the gaps)
    // is repeated, not sent once and stretched.
    const steps = frames.slice(1).map((frame, index) => frame.time - (frames[index]?.time ?? 0));
    expect(Math.max(...steps)).toBeLessThan(0.1);
    expect(frames[0]?.time).toBeLessThan(FRAME);
    // Both start together: the first take's picture at once, its sound after the few
    // milliseconds the sound takes to reach the recorder, which the picture waits out
    // on its first frame (so `lead` is under a couple of frames).
    const lead = sounds(runs, 440, 0) ?? Number.NaN;
    expect(lead).toBeLessThan(2 * FRAME);
    // The picture and the sound are as long as the edit, and as each other: the edit,
    // then the last frame held, silent, while the end of the sound reaches the recorder.
    const pictureEnds = (frames.at(-1)?.time ?? 0) + FRAME;
    const soundEnds = samples.length / rate;
    expect(pictureEnds).toBeGreaterThanOrEqual(3);
    // Held at each end for as long as the sound takes to reach the recorder (a few frames).
    expect(pictureEnds).toBeLessThan(3 + 10 * FRAME);
    expect(Math.abs(soundEnds - pictureEnds)).toBeLessThan(3 * FRAME);
    // None of the last take's sound is cut off.
    expect(runs.findLast((run) => run.tone === 880)?.end).toBeGreaterThan(lead + 3 - FRAME);

    // Each cut lands at its place in the edit, at the same moment in the picture and
    // in the sound; a gap holds the shot before it, silent.
    for (const [hue, tone, at] of [
      ["blue", 880, 1.4],
      ["green", 1320, 1.8],
      ["blue", 880, 2.5],
    ] as const) {
      const pictured = turns(frames, hue, at - 0.2) ?? Number.NaN;
      const heard = sounds(runs, tone, at - 0.2) ?? Number.NaN;
      expect(Math.abs(heard - lead - at)).toBeLessThan(FRAME);
      expect(Math.abs(pictured - heard)).toBeLessThan(2 * FRAME);
    }
    expect(Math.abs((sounds(runs, null, 0.9) ?? Number.NaN) - lead - 1)).toBeLessThan(FRAME);
    expect(frames.find((frame) => frame.time > 1.15 && frame.time < 1.3)?.hue).toBe("red");
  });

  it("waits for a hidden page, pauses while it's hidden, and carries on in step when it's back", {
    timeout: 60_000,
  }, async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const listen = vi.spyOn(document, "addEventListener");
    const start = vi.spyOn(MediaRecorder.prototype, "start");
    const pause = vi.spyOn(MediaRecorder.prototype, "pause");
    const resume = vi.spyOn(MediaRecorder.prototype, "resume");
    const changed = (state: DocumentVisibilityState) => {
      visibility.mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    };
    let hidden = false;
    const rendering = stitch([{ kind: "video", source: clip, startSeconds: 0, endSeconds: 1 }], {
      audio,
      withSound: true,
      onProgress: (done) => {
        if (done > 0.3 && !hidden) {
          hidden = true;
          changed("hidden");
        }
      },
      captions: { ...CAPTIONS, style: "off" },
    });
    // Hidden from the start: the render waits for the page (and its clock stops).
    await vi.waitFor(() => {
      const watching = listen.mock.calls.filter(([type]) => type === "visibilitychange");
      expect(watching.length).toBeGreaterThanOrEqual(3);
    });
    changed("hidden");
    await vi.waitFor(() => expect(audio.state).toBe("suspended"));
    expect(start).not.toHaveBeenCalled();
    changed("visible");
    // Hidden mid-render: the recorder and the clock stop together, then go on.
    await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(audio.state).toBe("suspended"));
    changed("visible");
    const short = await rendering;
    expect(resume).toHaveBeenCalledOnce();
    const frames = await playedFrames(short);
    // The hidden time isn't in the video: at most a frame or two where it paused and went
    // on (the recorder and the clock stop a few milliseconds apart), never the time away.
    const steps = frames.slice(1).map((frame, index) => frame.time - (frames[index]?.time ?? 0));
    expect(Math.max(...steps)).toBeLessThan(5 * FRAME);
    expect((frames.at(-1)?.time ?? 0) + FRAME).toBeLessThan(1 + 10 * FRAME);
  });

  it("records where the canvas can't be asked for frames, or a take won't play", async () => {
    vi.stubGlobal("CanvasCaptureMediaStreamTrack", undefined);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new DOMException("not now", "NotAllowedError"));
    const short = await stitch(
      [{ kind: "video", source: clip, startSeconds: 0, endSeconds: 0.5 }],
      {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        captions: CAPTIONS,
      },
    );
    vi.unstubAllGlobals();
    expect(play).toHaveBeenCalled();
    expect(await sizeOf(short)).toEqual([OUTPUT_WIDTH, OUTPUT_HEIGHT]);
  });

  it("leaves a photo's frames black where the browser gives no canvas to draw them on", async () => {
    // The render's own canvas draws; the one it draws a photo onto first gets none.
    const real = HTMLCanvasElement.prototype.getContext;
    let first: HTMLCanvasElement | null = null;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement["getContext"]>
    ) {
      first ??= this;
      return this === first ? real.apply(this, args) : null;
    });
    const short = await stitch([{ kind: "photo", source: photo, seconds: 0.4 }], {
      audio,
      withSound: false,
      onProgress: vi.fn(),
      captions: { ...CAPTIONS, style: "off" },
    });
    vi.restoreAllMocks();
    const frames = await playedFrames(short);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.hue === "green")).toBe(false);
  });

  it("waits for the recorder to finish writing, then gives back the whole video", async () => {
    const written = vi.spyOn(MediaRecorder.prototype, "requestData");
    const finishing = vi.fn();
    const short = await stitch(
      [{ kind: "video", source: clip, startSeconds: 0, endSeconds: 0.5 }],
      {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        onFinishing: finishing,
        captions: CAPTIONS,
      },
    );
    expect(finishing).toHaveBeenCalledOnce();
    // It looked at what was written before stopping.
    expect(written).toHaveBeenCalled();
    expect(await lastFrameSeconds(short)).toBeGreaterThanOrEqual(0.5 - 2 * FRAME);
  });

  it("refuses a recording whose picture stops before the edit's end", async () => {
    // As a recorder drops what its encoder hadn't got to when it stopped: the file, once
    // stopped, shows its last frame a fifth of a second in.
    let stopped = false;
    const stop = MediaRecorder.prototype.stop;
    vi.spyOn(MediaRecorder.prototype, "stop").mockImplementation(function (this: MediaRecorder) {
      stopped = true;
      stop.call(this);
    });
    const frameCallback = HTMLVideoElement.prototype.requestVideoFrameCallback;
    vi.spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback").mockImplementation(function (
      this: HTMLVideoElement,
      callback,
    ) {
      return frameCallback.call(this, (now, metadata) =>
        callback(now, stopped ? { ...metadata, mediaTime: 0.2 } : metadata),
      );
    });
    await expect(
      stitch([{ kind: "video", source: clip, startSeconds: 0, endSeconds: 0.5 }], {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        captions: CAPTIONS,
      }),
    ).rejects.toThrow(IncompleteRender);
  });

  it("records a lighter video when asked: 540×960", async () => {
    const short = await stitch([{ kind: "photo", source: photo, seconds: 0.3 }], {
      audio,
      withSound: false,
      onProgress: vi.fn(),
      captions: CAPTIONS,
      quality: "light",
    });
    expect(await sizeOf(short)).toEqual([540, 960]);
  });

  it("stops at once, unchecked, where the browser can't say how far a recording got", async () => {
    const frameCallback = Object.getOwnPropertyDescriptor(
      HTMLVideoElement.prototype,
      "requestVideoFrameCallback",
    );
    Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    try {
      const short = await stitch([{ kind: "photo", source: photo, seconds: 0.3 }], {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        captions: CAPTIONS,
      });
      expect(short.size).toBeGreaterThan(0);
      expect(await lastFrameSeconds(short)).toBeNull();
    } finally {
      if (frameCallback) {
        Object.defineProperty(
          HTMLVideoElement.prototype,
          "requestVideoFrameCallback",
          frameCallback,
        );
      }
    }
  });

  it("makes an empty video of an empty edit", async () => {
    const short = await stitch([], {
      audio,
      withSound: true,
      onProgress: vi.fn(),
      captions: CAPTIONS,
    });
    expect(short.type).toBe(recorderFormat()?.uploadType);
  });

  it("fails on a take that can't be read, letting go of what it had loaded", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const broken = new Blob(["not a video"], { type: "video/webm" });
    await expect(
      stitch(
        [
          { kind: "video", source: clip, startSeconds: 0, endSeconds: 1 },
          { kind: "video", source: broken, startSeconds: 0, endSeconds: 1 },
        ],
        { audio, withSound: false, onProgress: vi.fn(), captions: CAPTIONS },
      ),
    ).rejects.toThrow("a take couldn't be read");
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a video", { kind: "video", source: "clip", startSeconds: 0, endSeconds: 1 }],
    ["a photo", { kind: "photo", source: "photo", seconds: 1 }],
  ] as const)(
    "stops when cancelled in the middle of %s, recording nothing more",
    async (_, part) => {
      const segment: Segment =
        part.kind === "video" ? { ...part, source: clip } : { ...part, source: photo };
      const cancel = new AbortController();
      const stop = vi.spyOn(MediaRecorder.prototype, "stop");
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
      const rendering = stitch([segment, { kind: "photo", source: photo, seconds: 1 }], {
        audio,
        withSound: false,
        onProgress: (done) => {
          if (done > 0.05) {
            cancel.abort();
          }
        },
        captions: CAPTIONS,
        signal: cancel.signal,
      });
      await expect(rendering).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
      expect(stop).toHaveBeenCalledOnce();
      if (part.kind === "video") {
        expect(pause).toHaveBeenCalled();
      }
    },
  );

  it("starts nothing once already cancelled", async () => {
    const draw = vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage");
    const start = vi.spyOn(MediaRecorder.prototype, "start");
    await expect(
      stitch([{ kind: "photo", source: photo, seconds: 1 }], {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        captions: CAPTIONS,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(draw).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("fails in a browser that can't record video, or has no canvas", async () => {
    const options = { audio, withSound: false, onProgress: vi.fn(), captions: CAPTIONS };
    const supported = vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
    await expect(stitch([], options)).rejects.toThrow("this browser can't record video");
    supported.mockRestore();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(stitch([], options)).rejects.toThrow("no canvas to draw on");
  });
});
