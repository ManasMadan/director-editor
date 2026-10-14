/**
 * MediaPipe's object detector (EfficientDet-Lite0, the COCO classes), run in the browser
 * on the camera's frames, so Director can point at things the moment they're in view
 * without a round trip to Gemini. Loaded like the pose model (lib/pose-detector.ts): a
 * dynamic import, the runtime from jsDelivr, the weights from Google's model storage.
 */
import { type Seen, seenIn } from "./things";

const TASKS_VISION_VERSION = "1.1.0";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

export interface ThingDetector {
  detect(video: HTMLVideoElement, at: number): Seen[];
  close(): void;
}

export async function createThingDetector(): Promise<ThingDetector> {
  const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(WASM_BASE);
  const detector = await ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    scoreThreshold: 0.45,
    maxResults: 8,
  });
  return {
    detect(video, at) {
      const detections = detector.detectForVideo(video, at).detections.flatMap((found) => {
        const [category] = found.categories;
        return category && found.boundingBox
          ? [{ categoryName: category.categoryName, score: category.score, ...found.boundingBox }]
          : [];
      });
      return seenIn(detections, video.videoWidth, video.videoHeight);
    },
    close() {
      detector.close();
    },
  };
}
