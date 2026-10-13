/** Asks Director where to go for a shot, from one camera frame (a JPEG, base64). */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useCheckSceneMutation() {
  const { api } = useApi();
  return useMutation(api.director.checkScene.mutationOptions());
}
