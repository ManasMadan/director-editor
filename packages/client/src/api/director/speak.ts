/** A line in Director's own voice: a short-lived link to the WAV file to play. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSpeakMutation() {
  const { api } = useApi();
  return useMutation(api.director.speak.mutationOptions());
}
