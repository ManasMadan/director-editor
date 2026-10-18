/**
 * Asks where something Director named is in one camera frame (a JPEG, base64), for a
 * mark pinned to it on the shoot screen.
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useLocateMutation() {
  const { api } = useApi();
  return useMutation(api.director.locate.mutationOptions());
}
