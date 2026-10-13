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
