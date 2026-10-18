import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createProducer, type Producer } from "@repo/jobs";
import { REDIS, type Redis } from "@repo/nest-common";
import { FilesModule } from "../files";
import { RecordingRepository } from "./recording.repository";
import { DIRECTOR_QUEUE, RECORDING_QUEUE, RecordingService } from "./recording.service";

class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(RECORDING_QUEUE) private readonly queue: Producer<"recording">,
    @Inject(DIRECTOR_QUEUE) private readonly director: Producer<"ai-director">,
  ) {}
  async onApplicationShutdown() {
    await Promise.all([this.queue.close(), this.director.close()]);
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
    {
      // The post-session pass, which apps/ai's worker runs once a session is done.
      provide: DIRECTOR_QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("ai-director", redis),
    },
    QueueLifecycle,
    RecordingRepository,
    RecordingService,
  ],
  exports: [RecordingService],
})
export class RecordingModule {}
