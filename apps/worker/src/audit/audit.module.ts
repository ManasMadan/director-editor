import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { AuditProcessor } from "./audit.processor";

@Module({
  imports: [
    BullModule.registerQueue({ name: "events-audit", prefix: queuePrefix("events-audit") }),
  ],
  providers: [AuditProcessor],
})
export class AuditModule {}
