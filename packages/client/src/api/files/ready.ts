/**
 * Waiting for the worker's check of an upload (type sniffing, virus scan) before the file
 * is used: polled, since the check takes from a moment to minutes for a large video.
 */
import type { FileInfo } from "@repo/contracts/api";
import type { FileRejection } from "@repo/contracts/files";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import type { ApiClient } from "../../client";

/**
 * The worker turned the file down, or never answered. `code` is the error code, where
 * the app's error messages look for one (errorCode in ../../errors).
 */
class FileRejectedError extends Error {
  constructor(readonly code: FileRejection | "FILE_NOT_READY") {
    super(`file rejected: ${code}`);
  }
}

/**
 * The file once the worker has passed it; FileRejectedError when it didn't in `timeoutMs`.
 * `signal` stops the waiting (an AbortError) for a file nobody wants any more.
 */
export async function fileReady(
  client: ApiClient,
  file: FileInfo,
  timeoutMs = 2 * MINUTE_MS,
  signal?: AbortSignal,
): Promise<FileInfo> {
  const deadline = Date.now() + timeoutMs;
  let current = file;
  while (current.status === "pending" || current.status === "processing") {
    signal?.throwIfAborted();
    if (Date.now() > deadline) {
      throw new FileRejectedError("FILE_NOT_READY");
    }
    await new Promise((resolve) => setTimeout(resolve, SECOND_MS));
    current = await client.files.get({ fileId: current.id });
  }
  if (current.status === "rejected") {
    throw new FileRejectedError(current.rejectReason ?? "FILE_UNREADABLE");
  }
  return current;
}
