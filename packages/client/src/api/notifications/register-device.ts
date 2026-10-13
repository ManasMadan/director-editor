/** Registers this device for push: on app start, and when the user opts in. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRegisterDeviceMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.registerDevice.mutationOptions());
}
