/** Webhook endpoints of the active organization (owners and admins). */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useWebhookEndpointsQuery() {
  const { api } = useApi();
  return useQuery(api.webhooks.listEndpoints.queryOptions());
}
