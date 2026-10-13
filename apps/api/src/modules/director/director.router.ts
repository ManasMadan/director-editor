/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { DirectorService } from "./director.service";

export const directorRouter = ({ inOrg }: Procedures, director: DirectorService) => ({
  plan: inOrg.director.plan.handler(({ context, input }) =>
    director.plan(context.userId, context.orgId, input.videoId),
  ),
  requestPlan: inOrg.director.requestPlan.handler(({ context, input }) =>
    director.requestPlan(context.userId, context.orgId, input.videoId),
  ),
  checkScene: inOrg.director.checkScene.handler(({ context, input }) =>
    director.checkScene(context.userId, context.orgId, input),
  ),
  takes: inOrg.director.takes.handler(({ context, input }) =>
    director.takes(context.userId, context.orgId, input.videoId),
  ),
  addTake: inOrg.director.addTake.handler(({ context, input }) =>
    director.addTake(context.userId, context.orgId, input),
  ),
});
