/**
 * What each user wants to receive: their preferences (per category and channel), daily
 * digest and quiet hours, plus the suppression list (addresses that bounced, complained
 * or unsubscribed). Transactional categories ignore preferences.
 */
import { Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import {
  type NotificationCategory,
  type NotificationChannel,
  notificationCategories,
} from "@repo/contracts/notifications";
import { withUser } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

export interface UserPolicy {
  allows(category: NotificationCategory, channel: NotificationChannel): boolean;
  dailyDigest: boolean;
  quietHours: { start: number; end: number } | null;
}

export type SuppressionReason = "bounce" | "complaint" | "unsubscribe" | "invalid";

@Injectable()
export class DeliveryPolicy {
  constructor(@InjectDatabase() private readonly database: Database) {}

  async forUser(userId: UserId): Promise<UserPolicy> {
    const scoped = withUser(this.database.read, userId);
    const [preferences, settings] = await Promise.all([
      scoped.notificationPreference.findMany({
        where: { userId },
        select: { category: true, channel: true, enabled: true },
      }),
      scoped.notificationSettings.findUnique({
        where: { userId },
        select: { quietStart: true, quietEnd: true, dailyDigest: true },
      }),
    ]);
    const off = new Set(
      preferences.filter((row) => !row.enabled).map((row) => `${row.category}:${row.channel}`),
    );
    return {
      allows: (category, channel) =>
        !notificationCategories[category].mutable || !off.has(`${category}:${channel}`),
      dailyDigest: settings?.dailyDigest ?? false,
      quietHours:
        settings?.quietStart != null && settings.quietEnd != null
          ? { start: settings.quietStart, end: settings.quietEnd }
          : null,
    };
  }

  /** Never send to this address on this channel again (opted out, invalid, bouncing). */
  async suppress(channel: NotificationChannel, address: string, reason: SuppressionReason) {
    // The first reason recorded stands (this service may insert, never update).
    await this.database.write.$executeRaw`
      INSERT INTO notifications.suppression (channel, address, reason)
      VALUES (${channel}, ${address.toLowerCase()}, ${reason})
      ON CONFLICT (channel, address) DO NOTHING`;
  }

  async isSuppressed(channel: NotificationChannel, address: string) {
    const row = await this.database.read.notificationSuppression.findUnique({
      where: { channel_address: { channel, address: address.toLowerCase() } },
      select: { reason: true },
    });
    return row !== null;
  }
}
