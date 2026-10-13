/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { BillingService } from "./billing.service";

export const billingRouter = ({ orgAdmin }: Procedures, billing: BillingService) => ({
  overview: orgAdmin.billing.overview.handler(({ context }) => billing.overview(context.orgId)),
  checkout: orgAdmin.billing.checkout.handler(({ context, input }) =>
    billing.checkout(context.orgId, input.interval),
  ),
  portal: orgAdmin.billing.portal.handler(({ context }) => billing.portal(context.orgId)),
  invoices: orgAdmin.billing.invoices.handler(({ context }) => billing.invoices(context.orgId)),
});
