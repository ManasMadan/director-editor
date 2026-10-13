import { afterEach, describe, expect, it, vi } from "vitest";
import { LANDMARK_INDEX } from "@/modules/director/lib/pose";
import { createPoseDetector } from "@/modules/director/lib/pose-detector";

/** MediaPipe's landmarker, standing in for the model the page would download. */
const model = vi.hoisted(() => ({
  detectForVideo: vi.fn(),
  close: vi.fn(),
  forVisionTasks: vi.fn(async (base: string) => ({ wasmLoaderPath: `${base}/loader.js` })),
  createFromOptions: vi.fn(),
}));

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: model.forVisionTasks },
  PoseLandmarker: { createFromOptions: model.createFromOptions },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("the pose detector", () => {
  it("loads a pinned runtime from jsDelivr and the lite model, on the GPU, for video", async () => {
    model.createFromOptions.mockResolvedValue({
      detectForVideo: model.detectForVideo,
      close: model.close,
    });
    await createPoseDetector();
    expect(model.forVisionTasks).toHaveBeenCalledOnce();
    const [wasm = ""] = model.forVisionTasks.mock.calls[0] ?? [];
    expect(wasm).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\/wasm$/,
    );
    expect(model.createFromOptions).toHaveBeenCalledWith(
      { wasmLoaderPath: `${wasm}/loader.js` },
      {
        baseOptions: {
          modelAssetPath: expect.stringMatching(/pose_landmarker_lite\.task$/),
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      },
    );
  });

  it("finds the plan's joints in a frame, or none when no one is in it, then closes", async () => {
    model.createFromOptions.mockResolvedValue({
      detectForVideo: model.detectForVideo,
      close: model.close,
    });
    const detector = await createPoseDetector();
    const video = document.createElement("video");
    const person = Array.from({ length: 33 }, () => ({ x: 0.1, y: 0.2, visibility: 0.9 }));
    person[LANDMARK_INDEX.nose] = { x: 0.5, y: 0.1, visibility: 0.99 };
    model.detectForVideo.mockReturnValueOnce({ landmarks: [person] });
    const body = detector.detect(video, 1234);
    expect(model.detectForVideo).toHaveBeenCalledWith(video, 1234);
    expect(body?.nose).toEqual({ x: 0.5, y: 0.1 });
    expect(Object.keys(body ?? {})).toHaveLength(Object.keys(LANDMARK_INDEX).length);

    model.detectForVideo.mockReturnValueOnce({ landmarks: [] });
    expect(detector.detect(video, 1300)).toBeNull();

    expect(model.close).not.toHaveBeenCalled();
    detector.close();
    expect(model.close).toHaveBeenCalledOnce();
  });
});
