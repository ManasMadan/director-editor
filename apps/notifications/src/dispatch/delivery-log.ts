/**
 * The delivery log: one row per (job, channel, recipient), claimed before sending.
 *
 * Retried jobs, redelivered events and concurrent workers all go through `claim`, which
 * only lets a send proceed if it has never happened, failed last time, or was abandoned
 * mid-send (a crash) long enough ago. That makes every channel effectively exactly-once,
 * including SMTP, which has no idempotency of its own. The one remaining gap is a crash
 * after the provider accepted a message but before `finish`: that message may go twice.
 */
import { Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import { type Database, InjectDatabase, rows } from "@repo/nest-common";
import * as z from "zod";

export type DeliveryStatus = "sent" | "failed" | "skipped" | "suppressed";

/** A "sending" claim older than this is assumed abandoned and may be retried. */
const STALE_SENDING = "5 minutes";

@Injectable()
export class DeliveryLog {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** True if this send should happen now (and marks it as in progress). */
  async claim(
    key: string,
    channel: string,
    template: string,
    userId: UserId | null,
  ): Promise<boolean> {
    const claimed = await rows(
      z.object({ id: z.uuid() }),
      this.database.write.$queryRaw`
      INSERT INTO notifications.delivery (idempotency_key, channel, template, user_id, status, updated_at)
      VALUES (${key}, ${channel}, ${template}, ${userId}::uuid, 'sending', now())
      ON CONFLICT (idempotency_key) DO UPDATE SET status = 'sending', updated_at = now()
      WHERE notifications.delivery.status = 'failed'
         OR (notifications.delivery.status = 'sending'
             AND notifications.delivery.updated_at < now() - ${STALE_SENDING}::interval)
      RETURNING id`,
    );
    return claimed.length > 0;
  }

  async finish(
    key: string,
    status: DeliveryStatus,
    details: { providerMessageId?: string; error?: string } = {},
  ) {
    await this.database.write.notificationDelivery.update({
      where: { idempotencyKey: key },
      data: {
        status,
        providerMessageId: details.providerMessageId ?? null,
        error: details.error ?? null,
      },
    });
  }
}
