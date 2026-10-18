/**
 * Storage housekeeping, run by the maintenance scheduler:
 *
 *   - uploads never completed, or rejected, are forgotten after a day;
 *   - objects whose file row is gone (removed, replaced, or its user deleted; a
 *     database trigger queues them) are deleted from storage.
 */
import { Inject, Injectable } from "@nestjs/common";
import { HOUR_MS } from "@repo/contracts/time";
import {
  type Database,
  describeError,
  InjectDatabase,
  InjectPinoLogger,
  PinoLogger,
  STORAGE,
  type Storage,
} from "@repo/nest-common";

const STALE_HOURS = 24;
const BATCH = 500;

@Injectable()
export class FilesCleanup {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(STORAGE) private readonly storage: Storage | null,
    @InjectPinoLogger(FilesCleanup.name) private readonly log: PinoLogger,
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
    // Keyset through the queue, so a key that fails stays for the next run without being
    // read again in this one.
    let after: string | undefined;
    for (;;) {
      const queued = await db.fileObjectDeletion.findMany({
        take: BATCH,
        select: { key: true },
        orderBy: { key: "asc" },
        ...(after === undefined ? {} : { where: { key: { gt: after } } }),
      });
      const deleted = await this.deleteEach(
        this.storage,
        queued.map((q) => q.key),
      );
      await db.fileObjectDeletion.deleteMany({ where: { key: { in: deleted } } });
      objects += deleted.length;
      after = queued.at(-1)?.key;
      if (queued.length < BATCH) {
        break;
      }
    }
    return { stale, objects };
  }

  /**
   * Deletes each key on its own (one already gone counts as deleted): a key the bucket
   * refuses is logged and kept queued, and holds up none of the others. The keys deleted.
   */
  private async deleteEach(storage: Storage, keys: string[]) {
    const deleted: string[] = [];
    for (const key of keys) {
      try {
        await storage.delete(key);
        deleted.push(key);
      } catch (error) {
        this.log.warn({ key, err: describeError(error) }, "deleting a stored object failed");
      }
    }
    return deleted;
  }
}
