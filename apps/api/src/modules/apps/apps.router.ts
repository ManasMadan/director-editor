/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { AppsService } from "./apps.service";

export const appsRouter = ({ authed }: Procedures, apps: AppsService) => ({
  list: authed.apps.list.handler(({ context }) => apps.list(context.user.id)),
  disconnect: authed.apps.disconnect.handler(({ context, input }) =>
    apps.disconnect(context.user.id, input.id),
  ),
});
