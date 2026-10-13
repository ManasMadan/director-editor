/**
 * The in-app inbox: a notifications.notification row, then a realtime nudge so the
 * user's open tabs refresh their bell right away.
 */
import { Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import { realtimeChannel } from "@repo/contracts/realtime";
import { withUser } from "@repo/db";
import { type Database, InjectDatabase, InjectRedis, type Redis } from "@repo/nest-common";
import type { InAppMessage } from "../../dispatch/templates";
import { publishRealtime } from "../../realtime";

@Injectable()
export class InAppChannel {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async send(userId: UserId, message: InAppMessage) {
    const row = await withUser(this.database.write, userId).notification.create({
      data: {
        userId,
        orgId: message.orgId ?? null,
        template: message.type,
        data: message.data,
        link: message.link,
      },
      select: { id: true },
    });
    await publishRealtime(this.redis, realtimeChannel.user(userId), {
      type: "notifications.changed",
    });
    return row.id;
  }
}
