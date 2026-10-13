/** The active workspace's API keys (owners and admins). */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useApiKeysQuery() {
  const { api } = useApi();
  return useQuery(api.apiKeys.list.queryOptions());
}
