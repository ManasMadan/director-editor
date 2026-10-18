/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { AssetsService } from "./assets.service";

export const assetsRouter = ({ inOrg }: Procedures, assets: AssetsService) => ({
  list: inOrg.assets.list.handler(({ context, input }) =>
    assets.list(context.userId, context.orgId, input.videoId),
  ),
  draw: inOrg.assets.draw.handler(({ context, input }) =>
    assets.draw(context.userId, context.orgId, context.demo, input),
  ),
  addUpload: inOrg.assets.addUpload.handler(({ context, input }) =>
    assets.addUpload(context.userId, context.orgId, input),
  ),
  addStock: inOrg.assets.addStock.handler(({ context, input }) =>
    assets.addStock(context.userId, context.orgId, input),
  ),
  choose: inOrg.assets.choose.handler(({ context, input }) =>
    assets.choose(context.userId, context.orgId, input),
  ),
  searchStock: inOrg.assets.searchStock.handler(({ input }) => assets.searchStock(input)),
});
