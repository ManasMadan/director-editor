/** The active organization's invoices, newest first (owners and admins). */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useInvoicesQuery(enabled: boolean) {
  const { api } = useApi();
  return useQuery(api.billing.invoices.queryOptions({ enabled }));
}
