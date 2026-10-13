/**
 * Uploads (see packages/contracts api/files for the flow). The API only ever signs an
 * upload for exactly the file the client described, into quarantine; nothing uploaded
 * is served until apps/worker has checked it and moved it to `files/<id>`.
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type FileInfo, fileSchema } from "@repo/contracts/api";
import { type UploadPurpose, uploadPurposes } from "@repo/contracts/files";
import { type FileId, fileIdSchema, type UserId } from "@repo/contracts/ids";
import type { Producer } from "@repo/jobs";
import { AppError, STORAGE, type Storage } from "@repo/nest-common";
import { FilesRepository } from "./files.repository";

export const FILES_QUEUE = Symbol("FILES_QUEUE");

// Signed upload URLs are short-lived: long enough for a slow connection, no longer.
const UPLOAD_EXPIRES_IN = 10 * 60;
const DOWNLOAD_EXPIRES_IN = 5 * 60;

const quarantineKey = (fileId: FileId) => `quarantine/${fileId}`;
const storedKey = (fileId: FileId) => `files/${fileId}`;

interface FileRow {
  id: string;
  purpose: string;
  status: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  rejectReason: string | null;
  createdAt: Date;
}

// Parsed, not cast: a value the column holds but the contract doesn't know fails here.
const toInfo = (row: FileRow): FileInfo => fileSchema.parse(row);

@Injectable()
export class FilesService {
  constructor(
    private readonly files: FilesRepository,
    @Inject(STORAGE) private readonly optionalStorage: Storage | null,
    @Inject(FILES_QUEUE) private readonly queue: Producer<"files">,
  ) {}

  private get storage() {
    if (!this.optionalStorage) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "files" } });
    }
    return this.optionalStorage;
  }

  async createUpload(
    userId: UserId,
    input: { purpose: UploadPurpose; filename: string; contentType: string; size: number },
  ) {
    const storage = this.storage;
    const rules = uploadPurposes[input.purpose];
    if (!(rules.types as readonly string[]).includes(input.contentType)) {
      throw new AppError("FILE_TYPE_NOT_ALLOWED", { params: { types: rules.types.join(", ") } });
    }
    if (input.size > rules.maxBytes) {
      throw new AppError("FILE_TOO_LARGE", { params: { maxBytes: rules.maxBytes } });
    }
    const id = fileIdSchema.parse(randomUUID());
    const row = await this.files.create(userId, {
      id,
      purpose: input.purpose,
      filename: input.filename,
      declaredType: input.contentType,
      declaredSize: input.size,
    });
    const upload = await storage.presignUpload({
      key: quarantineKey(id),
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_EXPIRES_IN,
    });
    return { file: toInfo(row), upload };
  }

  /** Queues the check. Idempotent: completing twice (or after it's checked) is fine. */
  async complete(userId: UserId, fileId: FileId) {
    const storage = this.storage;
    const row = await this.find(userId, fileId);
    if (row.status !== "pending") {
      return toInfo(row);
    }
    if (!(await storage.head(quarantineKey(fileId)))) {
      throw new AppError("FILE_NOT_UPLOADED");
    }
    await this.queue.add("process", { fileId }, { jobId: fileId });
    return toInfo(row);
  }

  async get(userId: UserId, fileId: FileId) {
    return toInfo(await this.find(userId, fileId));
  }

  /** A ready file of the user's, for `purpose` (FILE_NOT_READY / FILE_NOT_FOUND). */
  async ready(userId: UserId, fileId: FileId, purpose: UploadPurpose) {
    const row = await this.find(userId, fileId);
    if (row.purpose !== purpose) {
      throw new AppError("FILE_NOT_FOUND");
    }
    if (row.status !== "ready") {
      throw new AppError("FILE_NOT_READY");
    }
    return toInfo(row);
  }

  /** Deletes the row; the database queues its stored objects for removal. */
  async remove(userId: UserId, fileId: FileId) {
    await this.files.remove(userId, fileId);
  }

  /**
   * A short-lived URL for a ready file the viewer may read (their own, or anyone's
   * avatar: row-level security decides). Null when there's no such file.
   */
  async downloadUrl(viewerId: UserId, fileId: FileId) {
    const row = await this.files.findReadable(viewerId, fileId);
    if (!row) {
      return null;
    }
    return this.storage.presignDownload(storedKey(fileId), {
      expiresInSeconds: DOWNLOAD_EXPIRES_IN,
      // Images are shown inline; anything else downloads rather than opening.
      ...(row.purpose !== "avatar" && { filename: row.filename }),
    });
  }

  private async find(userId: UserId, fileId: FileId) {
    const row = await this.files.find(userId, fileId);
    if (!row) {
      throw new AppError("FILE_NOT_FOUND");
    }
    return row;
  }
}
