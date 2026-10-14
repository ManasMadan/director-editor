import { afterEach, describe, expect, it, vi } from "vitest";
import { createThingDetector } from "@/modules/director/lib/object-detector";
import { cameraVideo } from "../support";

/** MediaPipe's object detector, standing in for the model the page would download. */
const model = vi.hoisted(() => ({
  detectForVideo: vi.fn(),
  close: vi.fn(),
  forVisionTasks: vi.fn(async (base: string) => ({ wasmLoaderPath: `${base}/loader.js` })),
  createFromOptions: vi.fn(),
}));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: model.forVisionTasks },
  ObjectDetector: { createFromOptions: model.createFromOptions },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("the object detector", () => {
  it("loads a pinned runtime and EfficientDet-Lite0, on the GPU, for video", async () => {
    model.createFromOptions.mockResolvedValue({
      detectForVideo: model.detectForVideo,
      close: model.close,
    });
    await createThingDetector();
    const [wasm = ""] = model.forVisionTasks.mock.calls[0] ?? [];
    expect(wasm).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\/wasm$/,
    );
    expect(model.createFromOptions).toHaveBeenCalledWith(
      { wasmLoaderPath: `${wasm}/loader.js` },
      expect.objectContaining({
        baseOptions: {
          modelAssetPath: expect.stringMatching(/efficientdet_lite0\.tflite$/),
          delegate: "GPU",
        },
        runningMode: "VIDEO",
      }),
    );
  });

  it("finds the things worth pointing out in the viewfinder, then closes", async () => {
    model.createFromOptions.mockResolvedValue({
      detectForVideo: model.detectForVideo,
      close: model.close,
    });
    const detector = await createThingDetector();
    const video = cameraVideo();
    const box = { originX: 108, originY: 192, width: 216, height: 384, angle: 0 };
    model.detectForVideo.mockReturnValueOnce({
      detections: [
        { categories: [{ categoryName: "cup", score: 0.9 }], boundingBox: box },
        // Nothing named, or nowhere: not a thing to point at.
        { categories: [], boundingBox: box },
        { categories: [{ categoryName: "dog", score: 0.8 }] },
        { categories: [{ categoryName: "fork", score: 0.9 }], boundingBox: box },
      ],
    });
    const [cup, ...rest] = detector.detect(video, 1234);
    expect(model.detectForVideo).toHaveBeenCalledWith(video, 1234);
    expect(rest).toEqual([]);
    expect(cup).toMatchObject({ thing: "cup", role: "prop", score: 0.9 });
    expect(cup?.box.x).toBeCloseTo(0.1);
    detector.close();
    expect(model.close).toHaveBeenCalledOnce();
  });
});
