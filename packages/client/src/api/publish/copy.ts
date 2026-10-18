/**
 * Gemini's draft of the YouTube post for a cut: a title, a description, hashtags and the
 * credits. A mutation, not a query: each draft is a model call, made when the publish
 * sheet opens, never again behind the member's back (a refetch on focus would be one).
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function usePublishCopyMutation() {
  const { api } = useApi();
  return useMutation(api.publish.copy.mutationOptions());
}
