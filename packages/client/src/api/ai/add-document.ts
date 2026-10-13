/** Adds a document; the assistant can use it once it's indexed. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAddDocumentMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.ai.addDocument.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.ai.documents.key() }),
    }),
  );
}
