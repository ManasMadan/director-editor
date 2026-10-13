/** Finds the short a pasted link points at (SHORT_NOT_FOUND when it isn't one). */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useLookupShortMutation() {
  const { api } = useApi();
  return useMutation(api.shorts.lookup.mutationOptions());
}
