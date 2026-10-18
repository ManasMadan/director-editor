import { BullModule } from "@nestjs/bullmq";
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createProducer, type Producer, queuePrefix } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { FilesModule } from "../files/files.module";
import { DIRECTOR_QUEUE, MaintenanceProcessor, RECORDING_QUEUE } from "./maintenance.processor";

class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(RECORDING_QUEUE) private readonly queue: Producer<"recording">,
    @Inject(DIRECTOR_QUEUE) private readonly director: Producer<"ai-director">,
  ) {}
  async onApplicationShutdown() {
    await this.queue.close();
    await this.director.close();
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
    {
      // The post-session passes of done sessions apps/api didn't queue.
      provide: DIRECTOR_QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("ai-director", redis),
    },
    QueueLifecycle,
    MaintenanceProcessor,
  ],
  exports: [MaintenanceProcessor],
})
export class MaintenanceModule {}
