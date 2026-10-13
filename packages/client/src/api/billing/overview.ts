/**
 * The active organization's plan (owners and admins).
 *
 *   const { data } = useBillingOverviewQuery();
 *
 * `untilPaid`: after returning from checkout, Stripe's webhook takes a moment to arrive,
 * so look again every couple of seconds (for up to a minute) until the plan is paid.
 */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useBillingOverviewQuery({ untilPaid = false }: { untilPaid?: boolean } = {}) {
  const { api } = useApi();
  return useQuery(
    api.billing.overview.queryOptions({
      refetchInterval: (query) =>
        untilPaid && query.state.data?.plan === "free" && query.state.dataUpdateCount < 30
          ? 2_000
          : false,
    }),
  );
}
