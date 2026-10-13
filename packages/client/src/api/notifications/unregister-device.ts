/** Stops push to this device: on sign-out, and when the user opts out. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useUnregisterDeviceMutation() {
  const { api } = useApi();
  return useMutation(api.notifications.unregisterDevice.mutationOptions());
}
