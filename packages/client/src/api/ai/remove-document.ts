/** Removes a document; the assistant stops using it. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRemoveDocumentMutation() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation(
    api.ai.removeDocument.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.ai.documents.key() }),
    }),
  );
}
