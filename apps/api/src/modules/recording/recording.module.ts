import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createProducer, type Producer } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { FilesModule } from "../files";
import { RecordingRepository } from "./recording.repository";
import { RECORDING_QUEUE, RecordingService } from "./recording.service";

class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RECORDING_QUEUE) private readonly queue: Producer<"recording">) {}
  async onApplicationShutdown() {
    await this.queue.close();
  }
}

@Module({
  imports: [FilesModule],
  providers: [
    {
      provide: RECORDING_QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("recording", redis),
    },
    QueueLifecycle,
    RecordingRepository,
    RecordingService,
  ],
  exports: [RecordingService],
})
export class RecordingModule {}
