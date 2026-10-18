/**
 * Tells Director, typed or said, what to change in the edit; the answer is edits for the
 * editor to apply, a question with candidate takes, or a kind no (contracts editor.ts).
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useAskEditorMutation() {
  const { api } = useApi();
  return useMutation(api.editor.ask.mutationOptions());
}
