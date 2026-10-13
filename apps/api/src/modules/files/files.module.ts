import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createProducer, type Producer } from "@repo/jobs";
import { createStorage, REDIS, type Redis, STORAGE } from "@repo/nest-common";
import { env } from "../../env";
import { FilesRepository } from "./files.repository";
import { FILES_QUEUE, FilesService } from "./files.service";

class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(FILES_QUEUE) private readonly queue: Producer<"files">) {}
  async onApplicationShutdown() {
    await this.queue.close();
  }
}

@Module({
  providers: [
    // Null when files are off (no S3_BUCKET): procedures answer FEATURE_DISABLED.
    { provide: STORAGE, useFactory: () => createStorage(env) },
    {
      provide: FILES_QUEUE,
      inject: [REDIS],
      useFactory: (redis: Redis) => createProducer("files", redis),
    },
    QueueLifecycle,
    FilesRepository,
    FilesService,
  ],
  exports: [FilesService],
})
export class FilesModule {}
