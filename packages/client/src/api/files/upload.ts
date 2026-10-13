/**
 * Uploading a file: ask the API for an upload, PUT the bytes straight to storage, then
 * complete it. The worker checks it next; `useFileQuery` (./get) follows its status.
 */
import { type UploadPurpose, uploadPurposes } from "@repo/contracts/files";
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

/** Why a file can't be uploaded for `purpose`, before anything is sent (or null). */
/** The rules of a purpose as its refusals' messages name them (`{types}`, `{maxBytes}`). */
export function uploadRuleParams(purpose: UploadPurpose) {
  const rules = uploadPurposes[purpose];
  return { types: rules.types.join(", "), maxBytes: rules.maxBytes };
}

export function checkUpload(
  purpose: UploadPurpose,
  file: { type: string; size: number },
): {
  code: "FILE_TYPE_NOT_ALLOWED" | "FILE_TOO_LARGE";
  params: Record<string, string | number>;
} | null {
  const rules = uploadPurposes[purpose];
  const { types, maxBytes } = uploadRuleParams(purpose);
  if (!(rules.types as readonly string[]).includes(file.type)) {
    return { code: "FILE_TYPE_NOT_ALLOWED" as const, params: { types } };
  }
  if (file.size > rules.maxBytes) {
    return { code: "FILE_TOO_LARGE" as const, params: { maxBytes } };
  }
  return null;
}

export class UploadFailedError extends Error {
  constructor(readonly status: number) {
    super(`upload to storage failed (${status})`);
  }
}

export function useUploadFileMutation() {
  const { api, client } = useApi();
  return useMutation({
    mutationKey: api.files.createUpload.key(),
    mutationFn: async ({ purpose, file }: { purpose: UploadPurpose; file: File }) => {
      const { file: created, upload } = await client.files.createUpload({
        purpose,
        filename: file.name,
        contentType: file.type,
        size: file.size,
      });
      // Content-Length is set by the browser from the body; the rest as signed.
      const headers = Object.fromEntries(
        Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
      );
      const response = await fetch(upload.url, { method: "PUT", headers, body: file });
      if (!response.ok) {
        throw new UploadFailedError(response.status);
      }
      return client.files.completeUpload({ fileId: created.id });
    },
  });
}
