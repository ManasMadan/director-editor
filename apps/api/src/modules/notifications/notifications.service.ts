/**
 * The signed-in user's inbox and delivery choices (notifications schema; apps/api may
 * read the inbox, mark it read, and edit preferences and settings). Every query is
 * scoped to the user by row-level security (withUser / userTx).
 */
import { Injectable } from "@nestjs/common";
import {
  type AppNotification,
  type NotificationPreferences,
  notificationCategorySchema,
  notificationSchema,
  type PushDeviceInput,
} from "@repo/contracts/api";
import { type NotificationId, type UserId, userIdSchema } from "@repo/contracts/ids";
import {
  mutableCategories,
  type NotificationCategory,
  type NotificationChannel,
  notificationCategories,
} from "@repo/contracts/notifications";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { realtimeChannel } from "@repo/contracts/realtime";
import { userTx } from "@repo/db";
import {
  AppError,
  createSignedTokens,
  type Database,
  InjectDatabase,
  InjectRedis,
  type Redis,
} from "@repo/nest-common";
import { env } from "../../env";
import { publishRealtime } from "../../realtime";
import { NotificationsRepository } from "./notifications.repository";

export interface PreferenceChanges {
  channels?:
    | { category: NotificationCategory; channel: NotificationChannel; enabled: boolean }[]
    | undefined;
  dailyDigest?: boolean | undefined;
  quietHours?: { start: number; end: number } | null | undefined;
}

/** Past this, registering a device forgets the one seen longest ago. */
const MAX_DEVICES_PER_USER = 20;

/**
 * How a device is stored: the native token, or the browser subscription as canonical JSON
 * (fixed key order), so registering and removing the same subscription match.
 */
function deviceToken(device: PushDeviceInput) {
  if (device.platform !== "web") {
    return device.token;
  }
  const { endpoint, keys } = device.subscription;
  return JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
}

@Injectable()
export class NotificationsService {
  private readonly tokens = createSignedTokens(env.UNSUBSCRIBE_SECRET);

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly repository: NotificationsRepository,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async list(userId: UserId, page: PageInput) {
    const rows = await this.repository.list(userId, page);
    const items: AppNotification[] = rows.map((row) =>
      notificationSchema.parse({ ...row, type: row.template, data: row.data ?? {} }),
    );
    return toPage(items, page.limit);
  }

  async unreadCount(userId: UserId) {
    return { count: await this.repository.unreadCount(userId) };
  }

  async markRead(userId: UserId, ids?: NotificationId[]) {
    await this.repository.markRead(userId, ids);
    // The user's other tabs and devices update their badge.
    await publishRealtime(this.redis, realtimeChannel.user(userId), {
      type: "notifications.changed",
    });
  }

  async preferences(userId: UserId): Promise<NotificationPreferences> {
    const [rows, settings] = await Promise.all([
      this.repository.preferences(userId),
      this.repository.settings(userId),
    ]);
    const saved = new Map(rows.map((row) => [`${row.category}:${row.channel}`, row.enabled]));
    return {
      categories: mutableCategories.map(({ name, channels }) => ({
        name,
        channels: channels.map((channel) => ({
          channel,
          enabled: saved.get(`${name}:${channel}`) ?? true,
        })),
      })),
      dailyDigest: settings?.dailyDigest ?? false,
      quietHours:
        settings?.quietStart != null && settings.quietEnd != null
          ? { start: settings.quietStart, end: settings.quietEnd }
          : null,
    };
  }

  async updatePreferences(userId: UserId, changes: PreferenceChanges) {
    for (const { category, channel } of changes.channels ?? []) {
      const known = notificationCategories[category];
      // Transactional email can't be turned off, and only a category's own channels exist.
      if (!known.mutable || !(known.channels as readonly string[]).includes(channel)) {
        throw new AppError("VALIDATION_FAILED", { params: { category, channel } });
      }
    }
    await userTx(this.database.write, userId, async (tx) => {
      for (const change of changes.channels ?? []) {
        await this.repository.setPreference(tx, userId, change);
      }
      if (changes.dailyDigest !== undefined || changes.quietHours !== undefined) {
        const settings = {
          ...(changes.dailyDigest !== undefined && { dailyDigest: changes.dailyDigest }),
          ...(changes.quietHours !== undefined && {
            quietStart: changes.quietHours?.start ?? null,
            quietEnd: changes.quietHours?.end ?? null,
          }),
        };
        await this.repository.setSettings(tx, userId, settings);
      }
    });
    return this.preferences(userId);
  }

  /**
   * The device is tied to this session: signing out or revoking it removes the device.
   * An admin impersonating the user can't register one (their device would get the
   * user's notifications).
   */
  async registerDevice(
    session: { userId: UserId; id: string; impersonatedBy?: string | null | undefined },
    device: PushDeviceInput,
    appVersion?: string,
  ) {
    if (session.impersonatedBy) {
      throw new AppError("FORBIDDEN");
    }
    const { userId } = session;
    return userTx(this.database.write, userId, async (tx) => {
      const id = await this.repository.registerDevice(tx, {
        platform: device.platform,
        token: deviceToken(device),
        appVersion: appVersion ?? null,
        sessionId: session.id,
      });
      await this.repository.pruneDevices(tx, userId, MAX_DEVICES_PER_USER);
      return { id };
    });
  }

  async unregisterDevice(userId: UserId, device: PushDeviceInput) {
    await this.repository.removeDevice(userId, deviceToken(device));
  }

  /** Turns off a category's email for the user a signed unsubscribe link names. */
  async unsubscribe(token: string) {
    const [signed, category] = this.tokens.verify("unsubscribe", token) ?? [];
    const userId = userIdSchema.safeParse(signed).data;
    const parsed = notificationCategorySchema.safeParse(category);
    if (!userId || !parsed.success || !notificationCategories[parsed.data].mutable) {
      throw new AppError("UNSUBSCRIBE_LINK_INVALID");
    }
    const name = parsed.data;
    await this.updatePreferences(userId, {
      channels: [{ category: name, channel: "email", enabled: false }],
    });
    return { category: name };
  }
}
