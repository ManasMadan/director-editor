/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { ShortsService } from "./shorts.service";

export const shortsRouter = ({ inOrg }: Procedures, shorts: ShortsService) => ({
  feed: inOrg.shorts.feed.handler(({ input }) => shorts.feed(input.topic, input.pageToken)),
  get: inOrg.shorts.get.handler(({ input }) => shorts.get(input.videoId)),
  lookup: inOrg.shorts.lookup.handler(({ input }) => shorts.lookup(input.url)),
  comments: inOrg.shorts.comments.handler(({ input }) => shorts.comments(input.videoId)),
  reactions: inOrg.shorts.reactions.handler(({ context, input }) =>
    shorts.reactionsOf(context.orgId, context.userId, input.videoId),
  ),
  react: inOrg.shorts.react.handler(({ context, input }) =>
    shorts.react(context.orgId, context.userId, input),
  ),
  saved: inOrg.shorts.saved.handler(({ context, input }) =>
    shorts.saved(context.orgId, context.userId, input.kind),
  ),
});
