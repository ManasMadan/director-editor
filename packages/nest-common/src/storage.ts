/**
 * Object storage behind one interface. Browsers upload and download directly with
 * short-lived presigned URLs, so file bytes never pass through our services.
 *
 *   const upload = await storage.presignUpload({ key, contentType: "image/png", contentLength: 48_213 });
 *   // client: PUT upload.url with upload.headers
 *   const { url } = await storage.presignDownload(key, { filename: "invoice.pdf" });
 *
 * Presigned PUT (not POST) because it works on every S3-compatible provider (R2 and GCS
 * don't support POST policies). The signature covers Content-Type and Content-Length,
 * so the client cannot swap in a larger or different file; the file-processing worker
 * still verifies size and type from the stored object before accepting it.
 *
 * Seam: `S3Storage` speaks the S3 API: RustFS, locally and in every cluster, and any other
 * S3-compatible provider (AWS S3, Cloudflare R2, GCS with HMAC keys, Azure through a gateway).
 * A provider without an S3 API gets its own `Storage` implementation; callers don't change.
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fieldOf, required } from "@repo/contracts/objects";

interface PresignedUpload {
  url: string;
  /** Headers the client must send with the PUT, exactly as given. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObject {
  size: number;
  contentType: string | undefined;
}

export interface Storage {
  presignUpload(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  presignDownload(
    key: string,
    options?: { filename?: string; expiresInSeconds?: number },
  ): Promise<{ url: string; expiresAt: Date }>;
  head(key: string): Promise<StoredObject | null>;
  /** The object's bytes; refuses objects larger than `maxBytes` (they're never buffered). */
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for non-AWS providers (RustFS, R2, GCS). Omit for AWS. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Needed by RustFS/MinIO-style servers without virtual-hosted buckets. */
  forcePathStyle?: boolean;
  /** How long one request may take, connecting included (default 30 s). */
  timeoutMs?: number;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint && { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle ?? false,
      // The SDK's own default waits forever on a server that stops answering, and its
      // requestTimeout only logs a warning unless told to throw.
      requestHandler: {
        connectionTimeout: Math.min(5_000, options.timeoutMs ?? 30_000),
        requestTimeout: options.timeoutMs ?? 30_000,
        throwOnRequestTimeout: true,
      },
      ...(options.accessKeyId &&
        options.secretAccessKey && {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }),
    });
  }

  async presignUpload({
    key,
    contentType,
    contentLength,
    expiresInSeconds = 300,
  }: Parameters<Storage["presignUpload"]>[0]) {
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      // Sign these headers so the upload must match what was approved.
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return {
      url,
      headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async presignDownload(
    key: string,
    { filename, expiresInSeconds = 300 }: { filename?: string; expiresInSeconds?: number } = {},
  ) {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      // Anything opened from storage downloads instead of rendering in our origin.
      ...(filename && {
        ResponseContentDisposition: `attachment; filename="${filename.replaceAll('"', "")}"`,
      }),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      // S3 always sends Content-Length for an object; the SDK's types just allow none.
      return {
        size: required(result.ContentLength, "Content-Length"),
        contentType: result.ContentType,
      };
    } catch (error) {
      if (fieldOf(error, "name") === "NotFound") {
        return null;
      }
      throw error;
    }
  }

  async read(key: string, maxBytes: number) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (required(result.ContentLength, "Content-Length") > maxBytes) {
      throw new Error(`${key} is larger than ${maxBytes} bytes`);
    }
    // A GetObject that succeeded always has a body (possibly empty).
    const body = required(result.Body, `${key}'s body`);
    return Buffer.from(await body.transformToByteArray());
  }

  async write(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async move(from: string, to: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        CopySource: `${this.options.bucket}/${from}`,
        Key: to,
      }),
    );
    await this.delete(from);
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

/** The configured storage, or null when files are off (no S3_BUCKET). */
export function createStorage(env: {
  S3_BUCKET?: string | undefined;
  S3_REGION: string;
  S3_ENDPOINT?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE: boolean;
}): Storage | null {
  if (!env.S3_BUCKET) {
    return null;
  }
  return new S3Storage({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    ...(env.S3_ACCESS_KEY_ID && { accessKeyId: env.S3_ACCESS_KEY_ID }),
    ...(env.S3_SECRET_ACCESS_KEY && { secretAccessKey: env.S3_SECRET_ACCESS_KEY }),
  });
}

export const STORAGE = Symbol("STORAGE");
