/**
 * Turns each customer-facing domain event into deliveries: one per enabled endpoint of
 * the event's organization that subscribes to it. Idempotent: a delivery is unique per
 * (endpoint, event), and its job id is the delivery id, so a redelivered event neither
 * creates nor sends anything twice.
 */
import { Processor } from "@nestjs/bullmq";
import { eventEnvelope } from "@repo/contracts/events";
import { webhookDeliveryIdSchema } from "@repo/contracts/ids";
import { withTenant } from "@repo/db";
import { createProducer, parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import {
  type Database,
  InjectDatabase,
  InjectRedis,
  JobProcessor,
  type Redis,
  runJob,
} from "@repo/nest-common";

@Processor("events-webhooks", { concurrency: 10, prefix: queuePrefix("events-webhooks") })
export class FanoutProcessor extends JobProcessor {
  private readonly deliveries;

  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectRedis() redis: Redis,
  ) {
    super();
    this.deliveries = createProducer("webhook-deliveries", redis);
  }

  async process(job: UncheckedJob) {
    const { meta, payload } = parseJob("events-webhooks", "event", job.data);
    const event = eventEnvelope.parse(payload);
    // Customer webhooks are per organization; events without one have no audience.
    const orgId = event.orgId;
    if (!orgId) {
      return;
    }
    await runJob(meta, `event:${event.id}`, async () => {
      const tenant = withTenant(this.database.write, orgId);
      const endpoints = await tenant.webhookEndpoint.findMany({
        where: {
          disabledAt: null,
          OR: [{ events: { isEmpty: true } }, { events: { has: event.name } }],
        },
        select: { id: true },
      });
      if (endpoints.length === 0) {
        return;
      }

      // Standard Webhooks payload shape: { type, timestamp, data }.
      const body = JSON.stringify({
        type: event.name,
        timestamp: event.occurredAt,
        data: event.payload,
      });
      await tenant.webhookDelivery.createMany({
        data: endpoints.map((endpoint) => ({
          endpointId: endpoint.id,
          orgId,
          eventId: event.id,
          eventName: event.name,
          body,
        })),
        skipDuplicates: true,
      });
      const deliveries = await tenant.webhookDelivery.findMany({
        where: { eventId: event.id, status: "pending" },
        select: { id: true },
      });
      await this.deliveries.addBulk(
        deliveries.map((delivery) => ({
          name: "deliver" as const,
          payload: { deliveryId: webhookDeliveryIdSchema.parse(delivery.id), orgId },
          options: { jobId: delivery.id, meta: { ...meta, orgId } },
        })),
      );
    });
  }

  async onModuleDestroy() {
    await this.deliveries.close();
  }
}
