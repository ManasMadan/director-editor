/**
 * Uploads: the client asks for an upload (and gets a presigned URL for exactly the file
 * it described), PUTs the bytes straight to storage, then completes it. The worker checks
 * the stored file before it becomes ready; clients watch its status (a `files.changed`
 * realtime nudge tells them when to look).
 */
import * as z from "zod";
import { fileRejections, fileStatuses, uploadPurposeNames } from "../files";
import { fileIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  "FEATURE_DISABLED",
  "FILE_NOT_FOUND",
  "FILE_NOT_READY",
  "FILE_NOT_UPLOADED",
  "FILE_TOO_LARGE",
  "FILE_TYPE_NOT_ALLOWED",
);

export const fileSchema = z.object({
  id: fileIdSchema,
  purpose: z.enum(uploadPurposeNames),
  status: z.enum(fileStatuses),
  filename: z.string(),
  /** Verified by the worker; null until ready. */
  contentType: z.string().nullable(),
  size: z.number().int().nullable(),
  rejectReason: z.enum(fileRejections).nullable(),
  createdAt: z.date(),
});
export type FileInfo = z.infer<typeof fileSchema>;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Files"], summary });

export const filesContract = {
  createUpload: route("POST", "/files/uploads", "Start an upload")
    .meta({ rateLimit: { name: "file-uploads", points: 30, windowSeconds: HOUR_S, per: "user" } })
    .input(
      z.object({
        purpose: z.enum(uploadPurposeNames),
        filename: z.string().trim().min(1).max(200),
        contentType: z.string().min(3).max(100),
        size: z.number().int().positive(),
      }),
    )
    .output(
      z.object({
        file: fileSchema,
        /** PUT the file's bytes here, with exactly these headers, before `expiresAt`. */
        upload: z.object({
          url: z.url(),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.date(),
        }),
      }),
    ),
  /** After the PUT succeeded: the file is checked and becomes ready (or rejected). */
  completeUpload: route("POST", "/files/{fileId}/complete", "Finish an upload")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ fileId: fileIdSchema }))
    .output(fileSchema),
  get: route("GET", "/files/{fileId}", "A file's status")
    .input(z.object({ fileId: fileIdSchema }))
    .output(fileSchema),
};
