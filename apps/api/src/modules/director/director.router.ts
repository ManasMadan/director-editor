/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { DirectorService } from "./director.service";

export const directorRouter = ({ inOrg }: Procedures, director: DirectorService) => ({
  library: inOrg.director.library.handler(({ context }) =>
    director.library(context.userId, context.orgId),
  ),
  index: inOrg.director.index.handler(({ context, input }) =>
    director.index(context.userId, context.orgId, input.url),
  ),
  plan: inOrg.director.plan.handler(({ context, input }) =>
    director.plan(context.userId, context.orgId, input.videoId),
  ),
  checkScene: inOrg.director.checkScene.handler(({ context, input }) =>
    director.checkScene(context.userId, context.orgId, input),
  ),
  locate: inOrg.director.locate.handler(({ context, input }) =>
    director.locate(context.userId, context.orgId, input),
  ),
  speak: inOrg.director.speak.handler(({ context, input }) =>
    director.speak(context.userId, context.orgId, input),
  ),
  takes: inOrg.director.takes.handler(({ context, input }) =>
    director.takes(context.userId, context.orgId, input.videoId),
  ),
  addTake: inOrg.director.addTake.handler(({ context, input }) =>
    director.addTake(context.userId, context.orgId, input),
  ),
  shots: inOrg.director.shots.handler(({ context, input }) =>
    director.shots(context.userId, context.orgId, input.videoId),
  ),
  cuts: inOrg.director.cuts.handler(({ context, input }) =>
    director.cuts(context.userId, context.orgId, input.videoId),
  ),
  saveCut: inOrg.director.saveCut.handler(({ context, input }) =>
    director.saveCut(context.userId, context.orgId, input),
  ),
  alignMatchCut: inOrg.director.alignMatchCut.handler(({ context, input }) =>
    director.alignMatchCut(context.userId, context.orgId, input),
  ),
  media: inOrg.director.media.handler(({ context }) =>
    director.media(context.userId, context.orgId),
  ),
});
