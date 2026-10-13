/** The signed-in user's workspaces (better-auth organizations). */
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient, Workspace } from "./client";
import { authData, authKeys } from "./query";

export function useWorkspacesQuery(auth: AuthQueryClient) {
  return useQuery({
    queryKey: authKeys.workspaceList(),
    queryFn: () => authData<Workspace[]>(auth.organization.list()),
  });
}
