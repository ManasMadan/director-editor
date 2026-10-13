/**
 * One of the user's files, followed until the worker has checked it: refetched on the
 * `files.changed` realtime nudge, and polled meanwhile in case one is missed.
 */
import type { FileInfo } from "@repo/contracts/api";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

const settled = (file: FileInfo | undefined) =>
  file?.status === "ready" || file?.status === "rejected";

export function useFileQuery(fileId: string | null) {
  const { api } = useApi();
  return useQuery(
    api.files.get.queryOptions({
      input: { fileId: fileId ?? "" },
      enabled: fileId !== null,
      refetchInterval: (query) => (settled(query.state.data) ? false : 3_000),
    }),
  );
}
