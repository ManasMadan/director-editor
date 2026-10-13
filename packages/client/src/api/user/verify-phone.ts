/** Checks the texted code and saves the number; the answer replaces `me`. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useVerifyPhoneMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.user.verifyPhone.mutationOptions({
      onSuccess: (me) => queryClient.setQueryData(api.user.me.queryKey(), me),
    }),
  );
}
