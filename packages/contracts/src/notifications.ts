/**
 * Notification channels and categories, shared by the notification service (what it may
 * send) and the apps (the preferences screen, rendering the inbox).
 *
 * Every template belongs to one category. Transactional categories (sign-in codes,
 * security alerts, invitations) always go out; the others can be turned off per
 * channel by each user. Adding a category: add it here with its default channels, give
 * it copy in packages/i18n (`notificationSettings.categories.<name>`), and point
 * templates at it.
 */
import * as z from "zod";
import { todoIdSchema, webhookEndpointIdSchema } from "./ids";
import { entriesOf } from "./objects";

export const notificationChannels = ["in_app", "email", "push", "sms"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const notificationCategories = {
  security: { mutable: false, channels: ["email", "sms"] },
  invitations: { mutable: false, channels: ["email"] },
  billing: { mutable: false, channels: ["in_app", "email"] },
  workspace: { mutable: true, channels: ["in_app", "email", "push"] },
  activity: { mutable: true, channels: ["in_app", "email", "push"] },
} as const satisfies Record<string, { mutable: boolean; channels: readonly NotificationChannel[] }>;
export type NotificationCategory = keyof typeof notificationCategories;

/** Categories users can change, with the channels they can change them on. */
export const mutableCategories = entriesOf(notificationCategories)
  .filter(([, category]) => category.mutable)
  .map(([name, category]) => ({ name, channels: category.channels }));

/**
 * In-app notification types and the data each carries. Apps render them from
 * packages/i18n (`notification.<type>.title` / `.body`, with the data as arguments).
 */
export const inAppNotifications = {
  "webhooks.endpoint-disabled": z.object({ endpointId: webhookEndpointIdSchema, url: z.string() }),
  "todo.reminder": z.object({ todoId: todoIdSchema, title: z.string() }),
  "billing.payment-failed": z.object({ amount: z.string() }),
} as const;
export type InAppNotificationType = keyof typeof inAppNotifications;

/** Where a device receives push: APNs (ios), FCM (android) or Web Push (web). */
export const pushPlatforms = ["ios", "android", "web"] as const;

/**
 * The browsers' push services. A Web Push subscription names the URL the notifications
 * service will POST to, so only these hosts are accepted: anything else would let a
 * client point the service at an internal address.
 */
const webPushHosts = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Opera, Samsung Internet
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari
  ".notify.windows.com", // Edge on Windows (per-region subdomains)
];

export function isWebPushEndpoint(endpoint: string, extraHosts: readonly string[] = []) {
  // The host must follow "https://" directly: no credentials, no port.
  const hostname = /^https:\/\/([a-z0-9.-]+)\//i.exec(endpoint)?.[1]?.toLowerCase();
  if (!hostname) {
    return false;
  }
  return [...webPushHosts, ...extraHosts].some((host) =>
    host.startsWith(".") ? hostname.endsWith(host) : hostname === host,
  );
}
