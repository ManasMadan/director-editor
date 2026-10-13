/**
 * Data access for the inbox, delivery preferences and push devices (notifications
 * schema). Reads and single writes go through withUser; multi-statement units take the
 * caller's userTx, so row-level security scopes every query to the user.
 */
import { Injectable } from "@nestjs/common";
import type { NotificationId, UserId } from "@repo/contracts/ids";
import type { NotificationCategory, NotificationChannel } from "@repo/contracts/notifications";
import type { PageInput } from "@repo/contracts/pagination";
import { type Tx, withUser } from "@repo/db";
import { type Database, InjectDatabase, row } from "@repo/nest-common";
import * as z from "zod";

interface Preference {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

@Injectable()
export class NotificationsRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** Newest first, `limit + 1` rows so the caller can tell whether another page exists. */
  list(userId: UserId, { limit, cursor }: PageInput) {
    return withUser(this.database.read, userId).notification.findMany({
      where: { userId, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, template: true, data: true, link: true, readAt: true, createdAt: true },
    });
  }

  unreadCount(userId: UserId) {
    return withUser(this.database.read, userId).notification.count({
      where: { userId, readAt: null },
    });
  }

  /** Marks the given unread notifications read, or all of them without `ids`. */
  async markRead(userId: UserId, ids?: NotificationId[]) {
    await withUser(this.database.write, userId).notification.updateMany({
      where: { userId, readAt: null, ...(ids && { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
  }

  preferences(userId: UserId) {
    return withUser(this.database.read, userId).notificationPreference.findMany({
      where: { userId },
      select: { category: true, channel: true, enabled: true },
    });
  }

  settings(userId: UserId) {
    return withUser(this.database.read, userId).notificationSettings.findUnique({
      where: { userId },
      select: { quietStart: true, quietEnd: true, dailyDigest: true },
    });
  }

  async setPreference(tx: Tx, userId: UserId, preference: Preference) {
    const { category, channel, enabled } = preference;
    await tx.notificationPreference.upsert({
      where: { userId_category_channel: { userId, category, channel } },
      create: { userId, category, channel, enabled },
      update: { enabled },
    });
  }

  async setSettings(
    tx: Tx,
    userId: UserId,
    settings: { dailyDigest?: boolean; quietStart?: number | null; quietEnd?: number | null },
  ) {
    await tx.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...settings },
      update: settings,
    });
  }

  /** Adds the device, or refreshes it if it's already registered; its id. */
  async registerDevice(
    tx: Tx,
    device: { platform: string; token: string; appVersion: string | null; sessionId: string },
  ) {
    const { id } = await row(
      z.object({ id: z.uuid() }),
      tx.$queryRaw`
        SELECT notifications.register_device(
          ${device.platform}, ${device.token}, ${device.appVersion}, ${device.sessionId}::uuid
        ) AS id`,
    );
    return id;
  }

  /** Forgets the user's devices past the `keep` seen most recently. */
  async pruneDevices(tx: Tx, userId: UserId, keep: number) {
    const stale = await tx.notificationDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
      skip: keep,
      select: { id: true },
    });
    if (stale.length > 0) {
      await tx.notificationDevice.deleteMany({ where: { id: { in: stale.map((d) => d.id) } } });
    }
  }

  async removeDevice(userId: UserId, token: string) {
    await withUser(this.database.write, userId).notificationDevice.deleteMany({
      where: { userId, token },
    });
  }
}
