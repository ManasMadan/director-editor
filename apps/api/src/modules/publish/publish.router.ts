/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { PublishService } from "./publish.service";

export const publishRouter = ({ inOrg }: Procedures, publish: PublishService) => ({
  copy: inOrg.publish.copy.handler(({ context, input }) =>
    publish.copy(context.userId, context.orgId, input.cutId),
  ),
  upload: inOrg.publish.upload.handler(({ context, input }) => publish.upload(context, input)),
});
