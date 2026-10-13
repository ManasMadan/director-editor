import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { DeliveryProcessor } from "./delivery.processor";
import { DeliveryService } from "./delivery.service";
import { FanoutProcessor } from "./fanout.processor";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: "events-webhooks", prefix: queuePrefix("events-webhooks") },
      { name: "webhook-deliveries", prefix: queuePrefix("webhook-deliveries") },
    ),
  ],
  providers: [FanoutProcessor, DeliveryProcessor, DeliveryService],
  exports: [DeliveryService],
})
export class OutboundModule {}
