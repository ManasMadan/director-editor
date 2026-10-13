/**
 * The API's producer for time-critical notifications (sign-in codes, invitations).
 * It reuses the service's Redis connection and is closed on shutdown so no job is lost
 * mid-write.
 */
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Tx } from "@repo/db";
import { createProducer, type NotificationPayload, type Producer } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { type EventOrigin, emitEvent } from "./outbox";

/**
 * Asks for a notification inside a transaction: an outbox event the notification service
 * sends from, so it goes out exactly when the change commits, however Redis is doing.
 * For what must not be lost (security alerts); the producer below is for the rest.
 */
export function requestNotification(
  tx: Tx,
  key: string,
  notification: NotificationPayload,
  origin: EventOrigin,
) {
  return emitEvent(tx, "notification.requested.v1", key, { notification }, origin);
}

export const CRITICAL_NOTIFICATIONS = Symbol("CRITICAL_NOTIFICATIONS");
export const InjectCriticalNotifications = () => Inject(CRITICAL_NOTIFICATIONS);
export type CriticalNotifications = Producer<"notifications-critical">;

class ProducerLifecycle implements OnApplicationShutdown {
  constructor(@InjectCriticalNotifications() private readonly producer: CriticalNotifications) {}
  async onApplicationShutdown() {
    await this.producer.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CRITICAL_NOTIFICATIONS,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("notifications-critical", redis),
    },
    ProducerLifecycle,
  ],
  exports: [CRITICAL_NOTIFICATIONS],
})
export class NotificationsProducerModule {}
