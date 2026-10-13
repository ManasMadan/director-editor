/**
 * MediaPipe's pose landmarker, run in the browser on the camera's frames: it finds the
 * person's joints for the pose outline and the framing hints. Loaded only on the camera
 * screen (a dynamic import), its runtime from jsDelivr and its weights from Google's
 * model storage (both in the CSP, src/proxy.ts).
 */
import type { Body } from "./pose";
import { bodyFromLandmarks } from "./pose";

/** The installed @mediapipe/tasks-vision; the runtime fetched must be the same version. */
const TASKS_VISION_VERSION = "1.1.0";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
/** The lite model: fast enough for every frame on a phone. */
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export interface PoseDetector {
  detect(video: HTMLVideoElement, at: number): Body | null;
  close(): void;
}

export async function createPoseDetector(): Promise<PoseDetector> {
  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return {
    detect(video, at) {
      const [landmarks] = landmarker.detectForVideo(video, at).landmarks;
      return landmarks ? bodyFromLandmarks(landmarks) : null;
    },
    close() {
      landmarker.close();
    },
  };
}
