/**
 * The active organization's audit log, newest first, page by page (owners and admins).
 *
 *   const log = useAuditLogInfiniteQuery();
 *   log.data?.pages.flatMap((page) => page.items)
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAuditLogInfiniteQuery(limit = 50) {
  const { api } = useApi();
  return useInfiniteQuery(
    api.audit.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit, ...(cursor && { cursor }) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
}
