/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { YourVersionService } from "./your-version.service";

export const yourVersionRouter = ({ inOrg }: Procedures, versions: YourVersionService) => ({
  get: inOrg.yourVersion.get.handler(({ context, input }) =>
    versions.get(context.userId, context.orgId, input.videoId),
  ),
  save: inOrg.yourVersion.save.handler(({ context, input }) =>
    versions.save(context.userId, context.orgId, input.videoId, input.version),
  ),
  revise: inOrg.yourVersion.revise.handler(({ context, input }) =>
    versions.revise(context.userId, context.orgId, input),
  ),
});
