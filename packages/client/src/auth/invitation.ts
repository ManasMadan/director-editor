/** A workspace invitation, opened from its email link (signed-in users only). */
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient } from "./client";
import { authData, authKeys } from "./query";

export function useInvitationQuery(auth: AuthQueryClient, id: string) {
  return useQuery({
    queryKey: authKeys.invitation(id),
    queryFn: () => authData(auth.organization.getInvitation({ query: { id } })),
    // Expired, answered or someone else's: asking again won't change that.
    retry: false,
  });
}
