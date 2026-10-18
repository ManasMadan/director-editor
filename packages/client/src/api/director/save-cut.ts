/**
 * Saves the member's cut: uploads the video the editor rendered, waits for the worker's
 * check, then records it with the take picked for each shot. It shows in My media next.
 */
import type { DirectorCut } from "@repo/contracts/api";
import { MINUTE_MS } from "@repo/contracts/time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../../client";
import { useApi } from "../../provider";
import { fileReady } from "../files/ready";
import { uploadFile } from "../files/upload";

/** A whole video is up to 100 MB: the virus scan alone takes longer than a take's. */
const CUT_CHECK_TIMEOUT_MS = 5 * MINUTE_MS;

interface CutInput {
  videoId: string;
  picks: DirectorCut["picks"];
  title: string;
  file: File;
  /**
   * The member cancelled or left: the upload stops, and no cut is saved. A cancel that
   * comes after the upload completed leaves its file behind, checked and ready but in no
   * cut: the files contract has no delete to call, and the worker's cleanup only removes
   * files still pending after a day, so a ready `director-cut-video` with no cut is a known
   * leftover. One that comes once the cut is being recorded is too late to stop it: the
   * cut is saved and shows in My media, though the editor says nothing of it.
   */
  signal?: AbortSignal;
}

async function saveCut(client: ApiClient, { file, signal, ...input }: CutInput) {
  const uploaded = await uploadFile(client, "director-cut-video", file, signal);
  const ready = await fileReady(client, uploaded, CUT_CHECK_TIMEOUT_MS, signal);
  signal?.throwIfAborted();
  return client.director.saveCut({ ...input, fileId: ready.id });
}

export function useSaveCutMutation() {
  const { api, client } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.director.saveCut.key(),
    mutationFn: (input: CutInput) => saveCut(client, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.director.media.key() }),
  });
}
