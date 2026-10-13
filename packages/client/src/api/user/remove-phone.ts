/** Removes the account's phone number; the answer replaces `me`. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRemovePhoneMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.user.removePhone.mutationOptions({
      onSuccess: (me) => queryClient.setQueryData(api.user.me.queryKey(), me),
    }),
  );
}
