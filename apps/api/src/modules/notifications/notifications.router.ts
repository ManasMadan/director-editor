/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { NotificationsService } from "./notifications.service";

export const notificationsRouter = (
  { authed, base }: Procedures,
  notifications: NotificationsService,
) => ({
  list: authed.notifications.list.handler(({ context, input }) =>
    notifications.list(context.user.id, input),
  ),
  unreadCount: authed.notifications.unreadCount.handler(({ context }) =>
    notifications.unreadCount(context.user.id),
  ),
  markRead: authed.notifications.markRead.handler(({ context, input }) =>
    notifications.markRead(context.user.id, input.ids),
  ),
  markAllRead: authed.notifications.markAllRead.handler(({ context }) =>
    notifications.markRead(context.user.id),
  ),
  preferences: authed.notifications.preferences.handler(({ context }) =>
    notifications.preferences(context.user.id),
  ),
  updatePreferences: authed.notifications.updatePreferences.handler(({ context, input }) =>
    notifications.updatePreferences(context.user.id, input),
  ),
  registerDevice: authed.notifications.registerDevice.handler(({ context, input }) =>
    notifications.registerDevice(context.session, input.device, input.appVersion),
  ),
  unregisterDevice: authed.notifications.unregisterDevice.handler(({ context, input }) =>
    notifications.unregisterDevice(context.user.id, input.device),
  ),
  unsubscribe: base.notifications.unsubscribe.handler(({ input }) =>
    notifications.unsubscribe(input.token),
  ),
});
