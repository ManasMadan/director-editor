/** The signed-in user's in-app notifications and what they choose to receive. */
import * as z from "zod";
import { notificationIdSchema } from "../ids";
import {
  inAppNotifications,
  isWebPushEndpoint,
  notificationCategories,
  notificationChannels,
} from "../notifications";
import { keysOf } from "../objects";
import { page, pageInput } from "../pagination";
import { base, EVERYDAY_WRITES, errorsOf } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf("UNSUBSCRIBE_LINK_INVALID");

const inAppType = z.enum(keysOf(inAppNotifications));
export const notificationCategorySchema = z.enum(keysOf(notificationCategories));

export const notificationSchema = z.object({
  id: notificationIdSchema,
  type: inAppType,
  /** Arguments for the type's copy (`notification.<type>.title` / `.body`). */
  data: z.record(z.string(), z.string()),
  /** Where it leads: a path on the web app. */
  link: z.string().nullable(),
  readAt: z.date().nullable(),
  createdAt: z.date(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

/** Minutes after midnight in the user's time zone. */
const minuteOfDay = z.number().int().min(0).max(1439);

const notificationPreferencesSchema = z.object({
  /** Every category users can change, with each channel's state. */
  categories: z.array(
    z.object({
      name: notificationCategorySchema,
      channels: z.array(z.object({ channel: z.enum(notificationChannels), enabled: z.boolean() })),
    }),
  ),
  dailyDigest: z.boolean(),
  /** Push and SMS wait until the end of quiet hours (both set, or neither). */
  quietHours: z.object({ start: minuteOfDay, end: minuteOfDay }).nullable(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** A browser's PushSubscription (`subscription.toJSON()`). */
const webPushSubscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((endpoint) => isWebPushEndpoint(endpoint), "Not a browser push service"),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

/** A device to push to: a native app's APNs/FCM token, or a browser's subscription. */
const pushDeviceSchema = z.discriminatedUnion("platform", [
  // APNs device tokens are hex; FCM registration tokens are URL-safe base64 with ":".
  z.object({ platform: z.literal("ios"), token: z.string().regex(/^[0-9a-fA-F]{64,200}$/) }),
  z.object({
    platform: z.literal("android"),
    token: z.string().regex(/^[\w:-]{20,4096}$/),
  }),
  z.object({ platform: z.literal("web"), subscription: webPushSubscriptionSchema }),
]);
export type PushDeviceInput = z.infer<typeof pushDeviceSchema>;

const route = (method: "GET" | "POST" | "PATCH", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Notifications"], summary });

export const notificationsContract = {
  list: route("GET", "/notifications", "In-app notifications, newest first")
    .input(pageInput)
    .output(page(notificationSchema)),
  unreadCount: route("GET", "/notifications/unread-count", "How many are unread").output(
    z.object({ count: z.number().int() }),
  ),
  markRead: route("POST", "/notifications/read", "Mark notifications as read")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ ids: z.array(notificationIdSchema).min(1).max(100) }))
    .output(z.void()),
  markAllRead: route("POST", "/notifications/read-all", "Mark every notification as read")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .output(z.void()),
  preferences: route("GET", "/notifications/preferences", "What the user receives").output(
    notificationPreferencesSchema,
  ),
  updatePreferences: route("PATCH", "/notifications/preferences", "Change what the user receives")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      z.object({
        channels: z
          .array(
            z.object({
              category: notificationCategorySchema,
              channel: z.enum(notificationChannels),
              enabled: z.boolean(),
            }),
          )
          .max(50)
          .optional(),
        dailyDigest: z.boolean().optional(),
        quietHours: z.object({ start: minuteOfDay, end: minuteOfDay }).nullable().optional(),
      }),
    )
    .output(notificationPreferencesSchema),
  /**
   * Called when the app starts with push allowed, and whenever the token changes. A
   * token registered by another account before (someone else signed in on this device)
   * moves to the caller.
   */
  registerDevice: route("POST", "/notifications/devices", "Receive push on this device")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(
      z.object({
        device: pushDeviceSchema,
        appVersion: z.string().max(50).optional(),
      }),
    )
    .output(z.object({ id: z.uuid() })),
  /** Called on sign-out and when the user turns push off on this device. */
  unregisterDevice: route(
    "POST",
    "/notifications/devices/remove",
    "Stop receiving push on this device",
  )
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ device: pushDeviceSchema }))
    .output(z.void()),
  /** From an email's unsubscribe link: no session, the signed token says who and what. */
  unsubscribe: route(
    "POST",
    "/notifications/unsubscribe-link",
    "Unsubscribe from a category's email",
  )
    .meta({
      rateLimit: {
        exempt:
          "No session to count against, and nothing to gain by repeating it: the signed token names the one category it turns off for the one user.",
      },
    })
    .input(z.object({ token: z.string().min(10).max(1000) }))
    .output(z.object({ category: notificationCategorySchema })),
};
