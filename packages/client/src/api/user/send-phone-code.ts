/** Texts a code to the number the user wants to add (verify it with useVerifyPhoneMutation). */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSendPhoneCodeMutation() {
  const { api } = useApi();
  return useMutation(api.user.sendPhoneCode.mutationOptions());
}
