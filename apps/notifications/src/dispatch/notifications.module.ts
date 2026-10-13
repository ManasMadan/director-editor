import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { EmailModule } from "../channels/email/email.module";
import { InAppModule } from "../channels/in-app/in-app.module";
import { PushModule } from "../channels/push/push.module";
import { SmsModule } from "../channels/sms/sms.module";
import { DigestService } from "../digest/digest.service";
import { EventsProcessor } from "../events/events.processor";
import { DeliveryLog } from "./delivery-log";
import { Dispatcher } from "./dispatcher";
import {
  BulkNotificationsProcessor,
  CriticalNotificationsProcessor,
} from "./notifications.processor";
import { DeliveryPolicy } from "./policy";
import { RecipientResolver } from "./recipients";
import { CodeTemplateSource, TemplateSource } from "./templates";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: "notifications-critical", prefix: queuePrefix("notifications-critical") },
      { name: "notifications-bulk", prefix: queuePrefix("notifications-bulk") },
      { name: "events-notifications", prefix: queuePrefix("events-notifications") },
    ),
    EmailModule,
    InAppModule,
    PushModule,
    SmsModule,
  ],
  providers: [
    CriticalNotificationsProcessor,
    BulkNotificationsProcessor,
    EventsProcessor,
    Dispatcher,
    DigestService,
    DeliveryLog,
    DeliveryPolicy,
    RecipientResolver,
    // Swap for a database-backed TemplateSource to edit templates without a deploy.
    { provide: TemplateSource, useClass: CodeTemplateSource },
  ],
})
export class NotificationsModule {}
