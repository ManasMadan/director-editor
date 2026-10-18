/**
 * Hands a recorded take to Director: uploads it, waits for the worker's check (type
 * sniffing, virus scan), then adds it to the shot, which queues Gemini's review.
 */
import type { DirectorTake } from "@repo/contracts/api";
import type { UploadPurpose } from "@repo/contracts/files";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../../client";
import { useApi } from "../../provider";
import { fileReady } from "../files/ready";
import { uploadFile } from "../files/upload";

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};

export interface TakeInput {
  videoId: string;
  shotIndex: number;
  kind: DirectorTake["kind"];
  file: File;
}

async function submitTake(client: ApiClient, input: TakeInput) {
  const uploaded = await uploadFile(client, PURPOSE[input.kind], input.file);
  const ready = await fileReady(client, uploaded);
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
    // The editor's shots list the takes too: a retake shows there on the way back.
    onSuccess: (_take, { videoId }) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: api.director.takes.queryKey({ input: { videoId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: api.director.shots.queryKey({ input: { videoId } }),
        }),
      ]),
  });
}
