/** The active workspace with its members and invitations, and the user's role in it. */
import { canManageWorkspace, parseOrgRole } from "@repo/contracts/roles";
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient, FullWorkspace } from "./client";
import { authData, authKeys } from "./query";

export function useActiveWorkspaceQuery(auth: AuthQueryClient) {
  const { data: session } = auth.useSession();
  const activeId = session?.session.activeOrganizationId;
  const userId = session?.user.id;
  const query = useQuery({
    queryKey: authKeys.activeWorkspace(activeId),
    enabled: Boolean(activeId),
    queryFn: () => authData<FullWorkspace>(auth.organization.getFullOrganization()),
  });
  // Parsed, not cast: a role the app doesn't know grants nothing (@repo/contracts/roles).
  const role = parseOrgRole(query.data?.members.find((member) => member.userId === userId)?.role);
  return { ...query, role, userId, isAdmin: canManageWorkspace(role) };
}
