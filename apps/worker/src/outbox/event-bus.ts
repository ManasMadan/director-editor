/**
 * Where the relay hands committed events: the EventBus seam.
 *
 * Today: BullMQ. Each event is copied into every subscriber queue whose filter accepts
 * it (`eventSubscribers` in packages/jobs), with jobId = event id, so a redelivered
 * event is dropped while its job is kept, and consumers dedupe on the id beyond that.
 * Delivery is at least once and unordered.
 *
 * At scale: a log-based broker (Kafka, Redpanda, NATS JetStream). Implement `publish`
 * to produce each event to one topic keyed by `event.key`, bind it in outbox.module.ts,
 * and turn each consumer into a consumer group. The relay and every producer stay as
 * they are.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { EventEnvelope } from "@repo/contracts/events";
import { keysOf } from "@repo/contracts/objects";
import { createProducer, type EventQueue, eventSubscribers, type Producer } from "@repo/jobs";
import { InjectRedis, type Redis } from "@repo/nest-common";

export abstract class EventBus {
  abstract publish(events: EventEnvelope[]): Promise<void>;
}

@Injectable()
export class BullMqEventBus extends EventBus implements OnModuleDestroy {
  private readonly producers: [EventQueue, Producer<EventQueue>][];

  constructor(@InjectRedis() redis: Redis) {
    super();
    this.producers = keysOf(eventSubscribers).map((queue) => [queue, createProducer(queue, redis)]);
  }

  async publish(events: EventEnvelope[]) {
    await Promise.all(
      this.producers.map(async ([queue, producer]) => {
        const accepted = events.filter((event) => eventSubscribers[queue](event.name));
        if (accepted.length === 0) {
          return;
        }
        await producer.addBulk(
          accepted.map((event) => ({
            name: "event" as const,
            payload: event,
            options: {
              jobId: event.id,
              meta: {
                ...(event.requestId && { requestId: event.requestId }),
                ...(event.actorId && { userId: event.actorId }),
                ...(event.orgId && { orgId: event.orgId }),
              },
            },
          })),
        );
      }),
    );
  }

  async onModuleDestroy() {
    await Promise.all(this.producers.map(([, producer]) => producer.close()));
  }
}
