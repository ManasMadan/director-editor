/** Sets (or, with null, removes) the profile picture; updates `me`. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSetAvatarMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.user.setAvatar.mutationOptions({
      onSuccess: (me) => queryClient.setQueryData(api.user.me.queryKey(), me),
    }),
  );
}
