/** Classifies a text with the Python AI service. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAiSentimentMutation() {
  const { api } = useApi();
  return useMutation(api.ai.sentiment.mutationOptions());
}
