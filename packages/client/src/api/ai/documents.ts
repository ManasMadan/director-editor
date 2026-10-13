/** The workspace's documents the assistant answers from. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAiDocumentsQuery() {
  const { api } = useApi();
  // Documents being prepared change status on their own; realtime says when, and a
  // slow poll covers a missed message.
  return useQuery(
    api.ai.documents.queryOptions({
      refetchInterval: (query) =>
        query.state.data?.some((d) => d.status === "pending" || d.status === "indexing")
          ? 5_000
          : false,
    }),
  );
}
