// The notifications module's public surface. Other modules import only from here.
export { NotificationsModule } from "./notifications.module";
export { notificationsRouter } from "./notifications.router";
export { NotificationsService } from "./notifications.service";
export { mountOneClickUnsubscribe } from "./unsubscribe.routes";
