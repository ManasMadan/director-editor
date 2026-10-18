/**
 * A photo for a brief (a template the member describes): uploaded, then waited on until
 * the worker has checked it, so the brief only ever names ready files.
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";
import { fileReady } from "../files/ready";
import { uploadFile } from "../files/upload";

export function useBriefPhotoMutation() {
  const { api, client } = useApi();
  return useMutation({
    mutationKey: api.files.createUpload.key(),
    mutationFn: async (file: File) =>
      fileReady(client, await uploadFile(client, "director-brief-photo", file)),
  });
}
