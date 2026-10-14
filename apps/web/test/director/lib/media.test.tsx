import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFrame, openCamera, stopStream } from "@/modules/director/lib/media";
import { canvasOf, hue, imageOf, pixel } from "./footage";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A camera stand-in: a landscape 320×180 picture, blue with a red band down its middle
 * 9:16, played in a video element the way the viewfinder plays the camera.
 */
async function landscapeCamera() {
  const { canvas, ctx } = canvasOf(320, 180);
  const paint = () => {
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(105, 0, 110, 180);
  };
  paint();
  const stream = canvas.captureStream();
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  const playing = video.play();
  await vi.waitFor(() => {
    paint();
    expect(video.videoWidth).toBe(320);
  });
  await playing;
  return { video, stream };
}

describe("the camera", () => {
  it("asks for the shot's camera in portrait, with the microphone only for sound", async () => {
    const stream = new MediaStream();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
    expect(await openCamera("front", true)).toBe(stream);
    await openCamera("back", false);
    const portrait = {
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      aspectRatio: { ideal: 9 / 16 },
    };
    expect(getUserMedia.mock.calls).toEqual([
      [
        {
          video: { facingMode: "user", ...portrait },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        },
      ],
      [{ video: { facingMode: "environment", ...portrait }, audio: false }],
    ]);
  });

  it("stops every track of a stream, and is fine with none", () => {
    const { canvas } = canvasOf(10, 10);
    const stream = canvas.captureStream();
    stopStream(stream);
    expect(stream.getTracks().map((track) => track.readyState)).toEqual(["ended"]);
    expect(() => stopStream(null)).not.toThrow();
  });
});

describe("capturing a frame", () => {
  it("takes the viewfinder's 9:16 middle as a JPEG, no wider than asked", async () => {
    const { video, stream } = await landscapeCamera();
    const frame = await captureFrame(video, 50, 0.9);
    stopStream(stream);
    expect(frame.type).toBe("image/jpeg");
    const image = await imageOf(frame);
    expect([image.naturalWidth, image.naturalHeight]).toEqual([50, 89]);
    // All of it the red middle: the blue sides are cropped away.
    for (const x of [2, 25, 47]) {
      expect(hue(pixel(image, 50, 89, x, 44))).toBe("red");
    }
  });

  it("keeps a small camera's frame at its own size", async () => {
    const { video, stream } = await landscapeCamera();
    const image = await imageOf(await captureFrame(video, 640, 0.9));
    stopStream(stream);
    expect([image.naturalWidth, image.naturalHeight]).toEqual([101, 180]);
  });

  it("is a 9:16 frame of the asked width before the camera shows anything", async () => {
    const image = await imageOf(await captureFrame(document.createElement("video"), 90, 0.5));
    expect([image.naturalWidth, image.naturalHeight]).toEqual([90, 160]);
  });

  it("fails when there's no frame to capture", async () => {
    await expect(captureFrame(document.createElement("video"), 0, 0.5)).rejects.toThrow(
      "no frame to capture",
    );
  });
});
