import { BullModule } from "@nestjs/bullmq";
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createProducer, type Producer, queuePrefix } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { FilesModule } from "../files/files.module";
import { MaintenanceProcessor, RECORDING_QUEUE } from "./maintenance.processor";

class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RECORDING_QUEUE) private readonly queue: Producer<"recording">) {}
  async onApplicationShutdown() {
    await this.queue.close();
  }
}

@Module({
  imports: [
    BullModule.registerQueue({ name: "maintenance", prefix: queuePrefix("maintenance") }),
    FilesModule,
  ],
  providers: [
    {
      // Recorded attempts of sessions it finishes, sent to the clipper.
      provide: RECORDING_QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("recording", redis),
    },
    QueueLifecycle,
    MaintenanceProcessor,
  ],
  exports: [MaintenanceProcessor],
})
export class MaintenanceModule {}
