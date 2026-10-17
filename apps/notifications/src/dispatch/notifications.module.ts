import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { EmailModule } from "../channels/email/email.module";
import { EventsProcessor } from "../events/events.processor";
import { DeliveryLog } from "./delivery-log";
import { Dispatcher } from "./dispatcher";
import { CriticalNotificationsProcessor } from "./notifications.processor";
import { DeliveryPolicy } from "./policy";
import { CodeTemplateSource, TemplateSource } from "./templates";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: "notifications-critical", prefix: queuePrefix("notifications-critical") },
      { name: "events-notifications", prefix: queuePrefix("events-notifications") },
    ),
    EmailModule,
  ],
  providers: [
    CriticalNotificationsProcessor,
    EventsProcessor,
    Dispatcher,
    DeliveryLog,
    DeliveryPolicy,
    // Swap for a database-backed TemplateSource to edit templates without a deploy.
    { provide: TemplateSource, useClass: CodeTemplateSource },
  ],
})
export class NotificationsModule {}
