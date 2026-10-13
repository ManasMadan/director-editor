/**
 * Checks an upload before anyone can see it:
 *
 *   1. the stored object's size is what was declared, within the purpose's limit;
 *   2. a virus scan finds nothing (before anything parses the bytes);
 *   3. its real type, from its bytes (not the name or the client's word), is allowed;
 *   4. per purpose, it's processed: avatars are decoded and re-encoded as a 512px WebP,
 *      which drops everything but pixels (EXIF, GPS, embedded payloads).
 *
 * Accepted files move from `quarantine/<id>` to `files/<id>`; rejected ones are deleted,
 * with the reason recorded. Either way the uploader's screens get a `files.changed`
 * nudge. Infrastructure failures (storage, clamd) throw, and the job is retried.
 *
 * At scale this is the part to move: its own deployment (CPU for sharp, memory for
 * files), fed by the same `files` queue.
 */
import { createHash } from "node:crypto";
import { Processor } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import {
  type FileRejection,
  type UploadPurpose,
  uploadPurposeNames,
  uploadPurposes,
} from "@repo/contracts/files";
import { type FileId, userIdSchema } from "@repo/contracts/ids";
import { realtimeChannel } from "@repo/contracts/realtime";
import { parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  InjectRedis,
  JobProcessor,
  PinoLogger,
  type Redis,
  runJob,
  STORAGE,
  type Storage,
} from "@repo/nest-common";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import * as z from "zod";
import { env } from "../env";
import { publishRealtime } from "../realtime/publish";
import { FILE_SCANNER, type FileScanner } from "./file-scanner";

const uploadPurpose = z.enum(uploadPurposeNames);

const AVATAR_SIZE = 512;
// Decoding bombs: refuse images claiming more pixels than a large photo has.
const MAX_INPUT_PIXELS = 50_000_000;

class Rejected extends Error {
  constructor(readonly reason: FileRejection) {
    super(reason);
  }
}

@Processor("files", { concurrency: env.FILES_CONCURRENCY, prefix: queuePrefix("files") })
export class FilesProcessor extends JobProcessor {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(STORAGE) private readonly storage: Storage | null,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
    @InjectRedis() private readonly redis: Redis,
    @InjectPinoLogger(FilesProcessor.name) private readonly log: PinoLogger,
  ) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload } = parseJob("files", "process", job.data);
    await runJob(meta, `job:${job.id}`, () => this.check(payload.fileId));
  }

  async check(fileId: FileId) {
    if (!this.storage) {
      throw new Error("files are off (no S3_BUCKET) but a file was queued");
    }
    const db = this.database.write;
    const file = await db.file.findUnique({ where: { id: fileId } });
    const quarantine = `quarantine/${fileId}`;
    if (!file) {
      return;
    }
    // Decided already, maybe by an attempt that crashed before removing the original:
    // only the cleanup is left (deleting is idempotent).
    if (file.status === "ready" || file.status === "rejected") {
      await this.storage.delete(quarantine);
      return;
    }
    // Pending or processing, the only other statuses (a check constraint says so).
    await db.file.update({ where: { id: fileId }, data: { status: "processing" } });

    try {
      const stored = await this.inspect(
        this.storage,
        uploadPurpose.parse(file.purpose),
        quarantine,
        file.declaredSize,
      );
      // Stored, then recorded, then the original removed: a crash at any point leaves a
      // retry either the original to check again or nothing but the cleanup.
      await this.storage.write(`files/${fileId}`, stored.body, stored.contentType);
      await db.file.update({
        where: { id: fileId },
        data: {
          status: "ready",
          contentType: stored.contentType,
          size: stored.body.length,
          sha256: createHash("sha256").update(stored.body).digest("hex"),
          readyAt: new Date(),
        },
      });
      await this.storage.delete(quarantine);
      this.log.info({ fileId, purpose: file.purpose }, "upload accepted");
    } catch (error) {
      if (!(error instanceof Rejected)) {
        throw error;
      }
      await db.file.update({
        where: { id: fileId },
        data: { status: "rejected", rejectReason: error.reason },
      });
      await this.storage.delete(quarantine);
      this.log.warn({ fileId, purpose: file.purpose, reason: error.reason }, "upload rejected");
    }
    const owner = userIdSchema.parse(file.userId);
    await publishRealtime(this.redis, realtimeChannel.user(owner), { type: "files.changed" });
  }

  private async inspect(
    storage: Storage,
    purpose: UploadPurpose,
    key: string,
    declaredSize: number,
  ) {
    const rules = uploadPurposes[purpose];
    const head = await storage.head(key);
    if (!head) {
      throw new Rejected("FILE_UNREADABLE");
    }
    if (head.size > rules.maxBytes) {
      throw new Rejected("FILE_TOO_LARGE");
    }
    // Not what the client said it would upload (smaller or larger): refused as such.
    if (head.size !== declaredSize) {
      throw new Rejected("FILE_SIZE_MISMATCH");
    }
    const bytes = await storage.read(key, rules.maxBytes);

    const scan = await this.scanner.scan(bytes);
    if (!scan.clean) {
      this.log.warn({ key, signature: scan.signature }, "virus found in an upload");
      throw new Rejected("FILE_INFECTED");
    }
    const sniffed = await fileTypeFromBuffer(bytes);
    if (!sniffed || !(rules.types as readonly string[]).includes(sniffed.mime)) {
      throw new Rejected("FILE_TYPE_NOT_ALLOWED");
    }

    switch (purpose) {
      case "avatar":
        try {
          const body = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
            .rotate() // apply the EXIF orientation before it's dropped
            .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
            .webp({ quality: 85 })
            .toBuffer();
          return { body, contentType: "image/webp" };
        } catch {
          throw new Rejected("FILE_UNREADABLE");
        }
    }
  }
}
