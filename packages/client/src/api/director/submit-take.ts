/**
 * Hands a recorded take to Director: uploads it, waits for the worker's check (type
 * sniffing, virus scan), then adds it to the shot, which queues Gemini's review.
 */
import type { DirectorTake, FileInfo } from "@repo/contracts/api";
import type { FileRejection, UploadPurpose } from "@repo/contracts/files";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../../client";
import { useApi } from "../../provider";
import { uploadFile } from "../files/upload";

const CHECK_POLL_MS = SECOND_MS;
const CHECK_TIMEOUT_MS = 2 * MINUTE_MS;

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};

/**
 * The worker turned the take down, or never answered. `code` is the error code, where
 * the app's error messages look for one (errorCode in ../../errors).
 */
class TakeRejectedError extends Error {
  constructor(readonly code: FileRejection | "FILE_NOT_READY") {
    super(`take rejected: ${code}`);
  }
}

async function checked(client: ApiClient, file: FileInfo, wait = CHECK_POLL_MS): Promise<FileInfo> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let current = file;
  while (current.status === "pending" || current.status === "processing") {
    if (Date.now() > deadline) {
      throw new TakeRejectedError("FILE_NOT_READY");
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    current = await client.files.get({ fileId: current.id });
  }
  if (current.status === "rejected") {
    throw new TakeRejectedError(current.rejectReason ?? "FILE_UNREADABLE");
  }
  return current;
}

export interface TakeInput {
  videoId: string;
  shotIndex: number;
  kind: DirectorTake["kind"];
  file: File;
}

async function submitTake(client: ApiClient, input: TakeInput, wait?: number) {
  const uploaded = await uploadFile(client, PURPOSE[input.kind], input.file);
  const ready = await checked(client, uploaded, wait);
  return client.director.addTake({
    videoId: input.videoId,
    shotIndex: input.shotIndex,
    kind: input.kind,
    fileId: ready.id,
  });
}

export function useSubmitTakeMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.director.addTake.key(),
    mutationFn: (input: TakeInput) => submitTake(client, input),
    onSuccess: (_take, input) =>
      queryClient.invalidateQueries({
        queryKey: api.director.takes.queryKey({ input: { videoId: input.videoId } }),
      }),
  });
}
