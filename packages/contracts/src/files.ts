/**
 * What can be uploaded, per purpose. Shared by the API (which signs uploads for exactly
 * these), the worker (which checks the stored bytes against them) and clients (which
 * refuse a file before uploading it).
 *
 * Adding a purpose: add it here with its types and limit, decide who may read it (the
 * files migration's row-level security), and what processing it gets (apps/worker
 * files processor).
 */
import type { FileId } from "@repo/contracts/ids";
import { keysOf } from "./objects";
export const uploadPurposes = {
  /** A profile picture: re-encoded to a square WebP, metadata (EXIF, GPS) stripped. */
  avatar: {
    types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxBytes: 5_000_000,
  },
  /**
   * A Director take recorded in the browser (MediaRecorder: WebM in Chromium and Firefox,
   * MP4 in Safari). Kept as recorded. The cap keeps a take inside the 20 MB Gemini takes
   * inline in one request once base64 has grown it by a third; the recorder aims at about
   * 1.5 Mbit/s, so a 60-second take fits.
   */
  "director-take-video": {
    types: ["video/webm", "video/mp4"],
    maxBytes: 15_000_000,
  },
  /** A Director photo shot, captured from the camera: re-encoded to JPEG, metadata stripped. */
  "director-take-photo": {
    types: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 8_000_000,
  },
  /**
   * A photo for a template a member describes (their space, a prop, a look they like),
   * shown to Gemini while it writes the plan: re-encoded to JPEG, metadata stripped, like
   * a photo take.
   */
  "director-brief-photo": {
    types: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 8_000_000,
  },
  /**
   * A Director cut: the picked takes rendered into one video in the browser, to keep and
   * publish to YouTube. Kept as rendered. The editor renders about 720x1280 at about
   * 4 Mbit/s, so a three-minute Short (the longest there is) fits. The cap is also what
   * the worker can check: it reads an upload into memory, and ClamAV scans at most
   * 100 MB of a stream by default.
   */
  "director-cut-video": {
    types: ["video/mp4", "video/webm"],
    maxBytes: 100_000_000,
  },
  /**
   * A picture of the member's for one of a Director plan's asset slots (the asset
   * picker's Upload): re-encoded at most 2160 pixels on its long side, to PNG when it has
   * transparency (a cutout) and JPEG otherwise, metadata stripped.
   */
  "director-asset-image": {
    types: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 15_000_000,
  },
} as const satisfies Record<string, { types: readonly string[]; maxBytes: number }>;

export type UploadPurpose = keyof typeof uploadPurposes;
export const uploadPurposeNames = keysOf(uploadPurposes);

export const fileStatuses = ["pending", "processing", "ready", "rejected"] as const;

/** Why the worker turned an upload down (error codes, translated by clients). */
export const fileRejections = [
  "FILE_TYPE_NOT_ALLOWED",
  "FILE_TOO_LARGE",
  "FILE_SIZE_MISMATCH",
  "FILE_INFECTED",
  "FILE_UNREADABLE",
] as const;
export type FileRejection = (typeof fileRejections)[number];

/** The path a stored file is served from (the API redirects to a short-lived URL). */
export const fileContentPath = (fileId: FileId) => `/api/v1/files/${fileId}/content`;
