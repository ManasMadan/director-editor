import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { CaptionInk } from "@/modules/director/lib/caption-draw";
import { recorderFormat } from "@/modules/director/lib/media";
import {
  type Captions,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  type Segment,
  stitch,
} from "@/modules/director/lib/stitch";
import { photoOf, recordClip } from "./footage";

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

let clip: Blob;
let photo: Blob;
let audio: AudioContext;

beforeAll(async () => {
  clip = await recordClip(1, ["#ff0000", "#0000ff"]);
  photo = await photoOf("#00ff00");
  audio = new AudioContext();
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

describe("stitching the short", () => {
  it("plays each take's part and each photo in order, captioned, into one 9:16 video", async () => {
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    const progress: number[] = [];
    const segments: Segment[] = [
      { kind: "video", source: clip, startSeconds: 0.1, endSeconds: 0.4 },
      { kind: "photo", source: photo, seconds: 0.3 },
      // Past the take's end: it plays to the end and moves on.
      { kind: "video", source: clip, startSeconds: 0.7, endSeconds: 3 },
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
  });

  it("records the takes' own sound when asked", async () => {
    // A take plays out loud only once the member has used the page (the button they tap).
    await userEvent.click(document.body);
    const connect = vi.spyOn(AudioNode.prototype, "connect");
    const source = vi.spyOn(audio, "createMediaElementSource");
    const short = await stitch(
      [{ kind: "video", source: clip, startSeconds: 0, endSeconds: 0.2 }],
      {
        audio,
        withSound: true,
        onProgress: vi.fn(),
        captions: { ...CAPTIONS, style: "off" },
      },
    );
    expect(source).toHaveBeenCalledOnce();
    expect(source.mock.calls[0]?.[0].muted).toBe(false);
    // Into the recording, not the speakers.
    expect(connect.mock.calls.map(([to]) => to instanceof MediaStreamAudioDestinationNode)).toEqual(
      [true],
    );
    expect(short.size).toBeGreaterThan(0);
  });

  it("fails on a take that can't be read, letting its address go", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const broken = new Blob(["not a video"], { type: "video/webm" });
    await expect(
      stitch([{ kind: "video", source: broken, startSeconds: 0, endSeconds: 1 }], {
        audio,
        withSound: false,
        onProgress: vi.fn(),
        captions: CAPTIONS,
      }),
    ).rejects.toThrow("a take couldn't be read");
    expect(revoke).toHaveBeenCalledOnce();
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
