/** Thin adapters from the contract to the service; no business logic lives here. */
import { type Procedures, requireFresh } from "../../rpc/procedures";
import type { WebhooksService } from "./webhooks.service";

export const webhooksRouter = (
  { orgAdmin, freshAdmin }: Procedures,
  webhooks: WebhooksService,
) => ({
  listEndpoints: orgAdmin.webhooks.listEndpoints.handler(({ context }) =>
    webhooks.listEndpoints(context.orgId),
  ),
  createEndpoint: freshAdmin.webhooks.createEndpoint.handler(({ context, input }) =>
    webhooks.createEndpoint(context.orgId, context.userId, input),
  ),
  // Pointing an endpoint somewhere else is as sensitive as creating one.
  updateEndpoint: orgAdmin.webhooks.updateEndpoint.handler(({ context, input }) => {
    if (input.url !== undefined) {
      requireFresh(context);
    }
    return webhooks.updateEndpoint(context.orgId, input);
  }),
  deleteEndpoint: orgAdmin.webhooks.deleteEndpoint.handler(({ context, input }) =>
    webhooks.deleteEndpoint(context.orgId, input.id),
  ),
  rotateSecret: orgAdmin.webhooks.rotateSecret.handler(({ context, input }) =>
    webhooks.rotateSecret(context.orgId, input.id),
  ),
  sendTest: orgAdmin.webhooks.sendTest.handler(({ context, input }) =>
    webhooks.sendTest(context.orgId, input.id),
  ),
  listDeliveries: orgAdmin.webhooks.listDeliveries.handler(({ context, input }) =>
    webhooks.listDeliveries(context.orgId, input.id, input),
  ),
  redeliver: orgAdmin.webhooks.redeliver.handler(({ context, input }) =>
    webhooks.redeliver(context.orgId, input.id),
  ),
});
