/** The user's passkeys. */
import { useQuery } from "@tanstack/react-query";
import type { AuthQueryClient, UserPasskey } from "./client";
import { authData, authKeys } from "./query";

export function usePasskeysQuery(auth: AuthQueryClient) {
  return useQuery({
    queryKey: authKeys.passkeys(),
    queryFn: () => authData<UserPasskey[]>(auth.passkey.listUserPasskeys()),
  });
}
