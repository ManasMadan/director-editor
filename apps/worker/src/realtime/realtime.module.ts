import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { RealtimeProcessor } from "./realtime.processor";

@Module({
  imports: [
    BullModule.registerQueue({ name: "events-realtime", prefix: queuePrefix("events-realtime") }),
  ],
  providers: [RealtimeProcessor],
})
export class RealtimeModule {}
