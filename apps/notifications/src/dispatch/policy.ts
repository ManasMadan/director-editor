/**
 * The suppression list: addresses that bounced or whose owner marked our mail as spam
 * (reported by our mail server through apps/webhooks). Nothing is sent to them again.
 */
import { Injectable } from "@nestjs/common";
import { type Database, InjectDatabase } from "@repo/nest-common";

export type SuppressionReason = "bounce" | "complaint";

@Injectable()
export class DeliveryPolicy {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** Never send to this address on this channel again. */
  async suppress(channel: "email", address: string, reason: SuppressionReason) {
    // The first reason recorded stands (this service may insert, never update).
    await this.database.write.$executeRaw`
      INSERT INTO notifications.suppression (channel, address, reason)
      VALUES (${channel}, ${address.toLowerCase()}, ${reason})
      ON CONFLICT (channel, address) DO NOTHING`;
  }

  async isSuppressed(channel: "email", address: string) {
    const row = await this.database.read.notificationSuppression.findUnique({
      where: { channel_address: { channel, address: address.toLowerCase() } },
      select: { reason: true },
    });
    return row !== null;
  }
}
