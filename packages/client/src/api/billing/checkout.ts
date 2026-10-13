/**
 * Starts a Stripe checkout for the paid plan.
 *
 *   const checkout = useCheckoutMutation();
 *   window.location.assign((await checkout.mutateAsync({ interval: "month" })).url);
 */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useCheckoutMutation() {
  const { api } = useApi();
  return useMutation(api.billing.checkout.mutationOptions());
}
