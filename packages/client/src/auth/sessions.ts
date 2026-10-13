/** The user's signed-in sessions, on every device. */
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient, SignedInSession } from "./client";
import { authData, authKeys } from "./query";

export function useSessionsQuery(auth: AuthQueryClient) {
  return useQuery({
    queryKey: authKeys.sessions(),
    queryFn: () => authData<SignedInSession[]>(auth.listSessions()),
    // A stale session (one that must sign in again first) won't become fresh by retrying.
    retry: false,
  });
}
