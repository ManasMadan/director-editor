/**
 * In-app notifications are written by the notification service, which doesn't run here:
 * tests put them in its table directly, as it would.
 */
import { vi } from "vitest";
import { commands } from "vitest/browser";

export async function notify(
  userId: string,
  {
    title = "Renew the domain",
    link = "/dashboard" as string | null,
    read = false,
    count = 1,
  } = {},
) {
  await commands.sql(
    `INSERT INTO notifications.notification (user_id, template, data, link, read_at, created_at)
     SELECT $1, 'todo.reminder', jsonb_build_object('todoId', gen_random_uuid(), 'title', $2 || n),
            $3, CASE WHEN $4 THEN now() END, now() - make_interval(secs => n)
     FROM generate_series(1, $5) AS n`,
    [userId, title, link, read, count],
  );
}

const base64url = (bytes: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/**
 * A stand-in for the browser's push service: headless Chromium has none behind
 * PushManager. Subscribing hands out a subscription on an FCM endpoint (with encryption
 * keys unless `keys` is false), which the real API then registers. The service worker
 * itself (public/sw.js) registers for real.
 */
export function fakePushService() {
  let current: PushSubscription | null = null;
  const push = {
    keys: true,
    get current() {
      return current;
    },
    /** A subscription this browser already had, as if from an earlier visit. */
    existing(options: { keys?: boolean } = {}) {
      current = subscription(options.keys ?? true);
      return current;
    },
  };
  const subscription = (keys: boolean) => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${base64url(12)}`;
    const json = { endpoint, keys: keys ? { p256dh: base64url(65), auth: base64url(16) } : {} };
    const created = {
      endpoint,
      toJSON: () => json,
      unsubscribe: async () => {
        if (current === created) {
          current = null;
        }
        return true;
      },
    } as unknown as PushSubscription;
    return created;
  };
  vi.spyOn(PushManager.prototype, "subscribe").mockImplementation(async () => {
    current = subscription(push.keys);
    return current;
  });
  vi.spyOn(PushManager.prototype, "getSubscription").mockImplementation(async () => current);
  return push;
}

/** The web push devices the API has for a user. */
export const devices = (userId: string) =>
  commands.sql<{ token: string }>(
    "SELECT token FROM notifications.device WHERE user_id = $1 AND platform = 'web'",
    [userId],
  );

/** Leaves the browser without its service worker, as a new visitor would be. */
export async function forgetServiceWorkers() {
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    await registration.unregister();
  }
}

/**
 * The notifications permission as the page sees it. Test pages run in an iframe, where
 * Chromium always reports notifications as denied, so the permission (and the prompt's
 * answer) is set on the page's Notification object instead of granted to the browser.
 */
export function notificationPermission(permission: NotificationPermission) {
  vi.spyOn(Notification, "permission", "get").mockReturnValue(permission);
  vi.spyOn(Notification, "requestPermission").mockResolvedValue(permission);
}
