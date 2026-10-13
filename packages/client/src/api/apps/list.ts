/** Apps (MCP clients) connected to the user's workspaces over OAuth. */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useConnectedAppsQuery() {
  const { api } = useApi();
  return useQuery(api.apps.list.queryOptions());
}
