/**
 * Query keys for better-auth's answers, and the unwrapping every auth query shares.
 * The auth hooks in this folder build their keys here, and so does anything that
 * refreshes them (`queryClient.invalidateQueries({ queryKey: authKeys.passkeys() })`).
 * Apps never write an `["auth", ...]` array themselves.
 */
export const authKeys = {
  /** Every workspace query: the list and each workspace fetched as the active one. */
  workspaces: () => ["auth", "workspace"] as const,
  workspaceList: () => [...authKeys.workspaces(), "list"] as const,
  activeWorkspace: (id: string | null | undefined) =>
    [...authKeys.workspaces(), "active", id] as const,
  invitation: (id: string) => ["auth", "invitation", id] as const,
  oauthClient: (clientId: string | null) => ["auth", "oauth-client", clientId] as const,
  sessions: () => ["auth", "sessions"] as const,
  passkeys: () => ["auth", "passkeys"] as const,
};

/** The data of a better-auth answer; its error is thrown, so the query shows it. */
export async function authData<T>(
  // better-auth answers either data or an error.
  call: Promise<{ data: T; error: null } | { data: null; error: object }>,
): Promise<T> {
  const answer = await call;
  if (answer.error) {
    throw answer.error;
  }
  return answer.data;
}
