"use client";

/**
 * The signed-in user's workspaces (better-auth organizations) and their role in the
 * active one, bound to the web's auth client (the queries are packages/client's), plus
 * switching. Switching changes which workspace every API call works in, so all cached
 * data is refetched.
 */
import { useActiveWorkspaceQuery } from "@repo/client/auth/active-workspace";
import { authKeys } from "@repo/client/auth/query";
import { useWorkspacesQuery } from "@repo/client/auth/workspaces";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as z from "zod";
import { authClient } from "@/lib/auth-client";

/** What a workspace's metadata says about it; the sign-up hook sets `personal`. */
const workspaceMetadata = z.object({ personal: z.boolean().optional() });

/** Personal workspaces (one per user, created at sign-up) can't be shared or deleted. */
export function isPersonal(organization: { metadata?: unknown }) {
  if (typeof organization.metadata !== "string") {
    return false;
  }
  try {
    return workspaceMetadata.safeParse(JSON.parse(organization.metadata)).data?.personal === true;
  } catch {
    return false;
  }
}

export function useWorkspaces() {
  return useWorkspacesQuery(authClient);
}

/** The active workspace with its members and invitations, and the user's role in it. */
export function useActiveWorkspace() {
  return useActiveWorkspaceQuery(authClient);
}

/** Refetches workspace data (after membership or settings changes). */
export function useRefreshWorkspaces() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: authKeys.workspaces() });
}

export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { refetch } = authClient.useSession();
  return async (organizationId: string) => {
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      throw error;
    }
    await refetch();
    // Every cached query belonged to the previous workspace.
    await queryClient.invalidateQueries();
    router.refresh();
  };
}
