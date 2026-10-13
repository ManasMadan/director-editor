import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { createStorage, STORAGE } from "@repo/nest-common";
import { env } from "../env";
import { ClamdScanner, FILE_SCANNER, NoScanner } from "./file-scanner";
import { FilesCleanup } from "./files.cleanup";
import { FilesProcessor } from "./files.processor";

/** The scanner env.ts asks for (exported for its test). */
export function createScanner() {
  if (env.FILE_SCANNER === "none") {
    return new NoScanner();
  }
  const url = new URL(env.CLAMAV_URL);
  return new ClamdScanner(url.hostname, Number(url.port || 3310));
}

@Module({
  imports: [BullModule.registerQueue({ name: "files", prefix: queuePrefix("files") })],
  providers: [
    { provide: STORAGE, useFactory: () => createStorage(env) },
    { provide: FILE_SCANNER, useFactory: createScanner },
    FilesProcessor,
    FilesCleanup,
  ],
  exports: [FilesProcessor, FilesCleanup],
})
export class FilesModule {}
