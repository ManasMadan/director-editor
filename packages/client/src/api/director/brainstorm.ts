/** Director's next turn while the member talks the template they want through. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useBrainstormMutation() {
  const { api } = useApi();
  return useMutation(api.director.brainstorm.mutationOptions());
}
