/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { RealtimeService } from "./realtime.service";

export const realtimeRouter = ({ inOrg }: Procedures, realtime: RealtimeService) => ({
  subscribe: inOrg.realtime.subscribe.handler(({ context, signal }) =>
    realtime.stream(context.userId, context.orgId, signal),
  ),
});
