/**
 * Storage housekeeping, run by the maintenance scheduler:
 *
 *   - uploads never completed, or rejected, are forgotten after a day;
 *   - objects whose file row is gone (removed, replaced, or its user deleted; a
 *     database trigger queues them) are deleted from storage.
 */
import { Inject, Injectable } from "@nestjs/common";
import { HOUR_MS } from "@repo/contracts/time";
import { type Database, InjectDatabase, STORAGE, type Storage } from "@repo/nest-common";

const STALE_HOURS = 24;
const BATCH = 500;

@Injectable()
export class FilesCleanup {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(STORAGE) private readonly storage: Storage | null,
  ) {}

  async run() {
    if (!this.storage) {
      return { stale: 0, objects: 0 };
    }
    const db = this.database.write;
    const { count: stale } = await db.file.deleteMany({
      where: {
        status: { in: ["pending", "processing", "rejected"] },
        createdAt: { lt: new Date(Date.now() - STALE_HOURS * HOUR_MS) },
      },
    });
    let objects = 0;
    for (;;) {
      const queued = await db.fileObjectDeletion.findMany({ take: BATCH, select: { key: true } });
      if (queued.length === 0) {
        break;
      }
      for (const { key } of queued) {
        await this.storage.delete(key); // idempotent
      }
      await db.fileObjectDeletion.deleteMany({ where: { key: { in: queued.map((q) => q.key) } } });
      objects += queued.length;
      if (queued.length < BATCH) {
        break;
      }
    }
    return { stale, objects };
  }
}
