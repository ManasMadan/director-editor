/**
 * The camera, the recorder and frames from them. MediaRecorder writes MP4 in Safari and
 * WebM elsewhere; both are upload types a take may have (packages/contracts files).
 */
import type { Shot } from "@repo/contracts/api";
import { VIEW_ASPECT, viewCrop } from "./view";

/** About 1.5 Mbit/s: a 60-second take, with its sound, stays inside a take upload's 15 MB. */
export const VIDEO_BITS_PER_SECOND = 1_500_000;

const RECORDER_TYPES = [
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/** The best format this browser records in, and the upload type it is. */
export function recorderFormat(
  supported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): { mimeType: string; uploadType: "video/mp4" | "video/webm" } | null {
  const mimeType = RECORDER_TYPES.find(supported);
  if (!mimeType) {
    return null;
  }
  return { mimeType, uploadType: mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm" };
}

/** The shot's camera, portrait, with the microphone when the take records sound. */
export function openCamera(camera: Shot["camera"], withSound: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: camera === "front" ? "user" : "environment",
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      aspectRatio: { ideal: 9 / 16 },
    },
    // The browser's own clean-up, so a take (and what Director hears) is the member's
    // voice and not the room.
    audio: withSound
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false,
  });
}

/** The member's screen (or a window or tab of it), to show Director. */
export function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

export function stopStream(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

/**
 * What the viewfinder shows now (the camera's frame cropped to 9:16, not mirrored), as a
 * JPEG at most `maxWidth` wide: a photo take, or the frame a scene check sends, whose
 * answers are then in the viewfinder's own space.
 */
export function captureFrame(
  video: HTMLVideoElement,
  maxWidth: number,
  quality: number,
): Promise<Blob> {
  const crop = viewCrop(video.videoWidth || maxWidth, video.videoHeight || maxWidth / VIEW_ASPECT);
  const scale = Math.min(1, maxWidth / crop.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(crop.width * scale);
  canvas.height = Math.round(crop.height * scale);
  canvas
    .getContext("2d")
    ?.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("no frame to capture"))),
      "image/jpeg",
      quality,
    ),
  );
}

/** A blob's bytes as base64, without the `data:` prefix. */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}
