/** Opens Stripe's billing portal, where owners change the plan, card or invoices. */
import { useMutation } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function usePortalMutation() {
  const { api } = useApi();
  return useMutation(api.billing.portal.mutationOptions());
}
