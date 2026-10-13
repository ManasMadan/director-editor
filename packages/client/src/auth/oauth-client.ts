/** The public details of an app asking, over OAuth, to act for the user (its name). */
import { skipToken, useQuery } from "@tanstack/react-query";
import type { AuthQueryClient } from "./client";
import { authData, authKeys } from "./query";

export function useOAuthClientQuery(auth: AuthQueryClient, clientId: string | null) {
  return useQuery({
    queryKey: authKeys.oauthClient(clientId),
    retry: false,
    // Without a client id there is nothing to ask for, so the query doesn't run.
    queryFn: clientId
      ? () => authData(auth.oauth2.publicClient({ query: { client_id: clientId } }))
      : skipToken,
  });
}
