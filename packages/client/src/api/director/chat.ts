/**
 * One turn of Director's slower line, when Gemini Live can't run: the member's turn (or
 * what happened on screen) goes up, Director's reply and tool calls come back.
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useDirectorChatMutation() {
  const { api } = useApi();
  return useMutation(api.director.chat.mutationOptions());
}
