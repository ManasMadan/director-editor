/**
 * Object storage behind one interface. Browsers upload and download directly with
 * short-lived presigned URLs, so file bytes never pass through our services.
 *
 *   const upload = await storage.presignUpload({ key, contentType: "image/png", contentLength: 48_213 });
 *   // client: PUT upload.url with upload.headers
 *   const { url } = await storage.presignDownload(key, { filename: "invoice.pdf" });
 *
 * Presigned PUT (not POST) because it works on every S3-compatible provider (R2 and GCS
 * don't support POST policies). On both implementations the signature covers
 * Content-Type and Content-Length, so the client cannot swap in a larger or different
 * file; the file-processing worker still verifies size and type from the stored object
 * before accepting it.
 *
 * Seam: `STORAGE_PROVIDER` chooses the implementation (`createStorage`, below).
 * `S3Storage` speaks the S3 API: RustFS, locally and in every cluster, and any other
 * S3-compatible provider (AWS S3, Cloudflare R2, GCS with HMAC keys, Azure through a
 * gateway). `GcsStorage` speaks the GCS JSON API directly, with Application Default
 * Credentials (on the production VM, its service account through the metadata server;
 * no key file): production's bucket, so another Google service in the same project
 * (Gemini on Vertex, reviewing a Director take) can read an object by its `gs://` URI,
 * with its own credentials, instead of a presigned URL (`directUri`). A provider with neither API gets its own `Storage`
 * implementation; callers don't change.
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
import { Storage as GcsClient } from "@google-cloud/storage";
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
  /**
   * A reference another Google Cloud service can read directly, with its own
   * credentials, instead of a presigned URL (`gs://bucket/key` on GCS); null when the
   * provider has no such reference (every other provider: the caller falls back to
   * `presignDownload`).
   */
  directUri(key: string): string | null;
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

  directUri(_key: string) {
    // RustFS and any other S3-compatible provider are reached only through a presigned
    // URL: nothing else in the cluster has its own credentials for them.
    return null;
  }
}

/**
 * The slice of `@google-cloud/storage`'s client `GcsStorage` calls, so a test can pass a
 * fake speaking only this much instead of the whole SDK (the real client satisfies it as
 * is: this is narrower, not different).
 */
export interface GcsFile {
  getSignedUrl(
    config: { version: "v4"; expires: Date } & (
      | { action: "read"; responseDisposition?: string }
      | { action: "write"; contentType: string; extensionHeaders: Record<string, string> }
    ),
  ): Promise<[string]>;
  getMetadata(): Promise<
    [{ size?: string | number; contentType?: string; generation?: string | number }, ...unknown[]]
  >;
  download(): Promise<[Buffer]>;
  save(data: Buffer, options: { contentType: string; resumable: boolean }): Promise<void>;
  rename(destination: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface GcsClientLike {
  bucket(name: string): {
    /** `generation` pins one version of the object, instead of whatever is live. */
    file(key: string, options?: { generation?: string | number }): GcsFile;
  };
}

export interface GcsStorageOptions {
  bucket: string;
  /** A fake in tests; the real `@google-cloud/storage` client otherwise. */
  client?: GcsClientLike;
}

/**
 * GCS over its own JSON API (not the S3-compatible one), with Application Default
 * Credentials: in production the VM's service account, from the metadata server (k3s on
 * one GCE VM, no workload identity), `gcloud auth application-default login` locally. No
 * key file, and none of this ever needs one: a service account with
 * `roles/storage.objectAdmin` on the bucket can read, write and sign for it; `getSignedUrl` falls back to the IAM Credentials API's `signBlob` to sign
 * when the credentials have no private key of their own (the metadata server's), which
 * needs `roles/iam.serviceAccountTokenCreator` on that same service account.
 */
export class GcsStorage implements Storage {
  private readonly client: GcsClientLike;
  private readonly bucket: string;

  constructor(options: GcsStorageOptions) {
    this.client = options.client ?? new GcsClient();
    this.bucket = options.bucket;
  }

  private file(key: string, options: { generation?: string | number } = {}) {
    return this.client.bucket(this.bucket).file(key, options);
  }

  async presignUpload({
    key,
    contentType,
    contentLength,
    expiresInSeconds = 300,
  }: Parameters<Storage["presignUpload"]>[0]) {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const [url] = await this.file(key).getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
      // Signed like Content-Type, so the URL can't be reused to upload any other size
      // until it expires (X-Goog-SignedHeaders=content-length;content-type;host). V4
      // signs any header given here, not only `x-goog-` ones.
      extensionHeaders: { "content-length": String(contentLength) },
    });
    return {
      url,
      headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      expiresAt,
    };
  }

  async presignDownload(
    key: string,
    { filename, expiresInSeconds = 300 }: { filename?: string; expiresInSeconds?: number } = {},
  ) {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const [url] = await this.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt,
      // Anything opened from storage downloads instead of rendering in our origin.
      ...(filename && {
        responseDisposition: `attachment; filename="${filename.replaceAll('"', "")}"`,
      }),
    });
    return { url, expiresAt };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      return {
        size: Number(required(metadata.size, "size")),
        contentType: metadata.contentType,
      };
    } catch (error) {
      if (fieldOf(error, "code") === 404) {
        return null;
      }
      throw error;
    }
  }

  async read(key: string, maxBytes: number) {
    const [metadata] = await this.file(key).getMetadata();
    if (Number(required(metadata.size, "size")) > maxBytes) {
      throw new Error(`${key} is larger than ${maxBytes} bytes`);
    }
    // The generation whose size was just checked: an upload replacing the object in
    // between can't get a larger one buffered (that download then fails, not succeeds).
    const generation = required(metadata.generation, "generation");
    const [buffer] = await this.file(key, { generation }).download();
    return buffer;
  }

  async write(key: string, body: Buffer, contentType: string) {
    await this.file(key).save(body, { contentType, resumable: false });
  }

  async move(from: string, to: string) {
    await this.file(from).rename(to);
  }

  async delete(key: string) {
    await this.file(key).delete();
  }

  directUri(key: string) {
    return `gs://${this.bucket}/${key}`;
  }
}

interface StorageChoice {
  STORAGE_PROVIDER: "s3" | "gcs";
  S3_BUCKET?: string | undefined;
  GCS_BUCKET?: string | undefined;
}

/**
 * The chosen provider's bucket, or undefined when files are off. The one place that
 * decides whether files are on: `createStorage`, the api's features and the worker's
 * boot checks all ask here. A half-configured choice throws, so the service stops at
 * boot instead of quietly turning files off or ignoring a bucket: `gcs` without
 * `GCS_BUCKET`, or the other provider's bucket set.
 */
export function storageBucket(env: StorageChoice): string | undefined {
  if (env.STORAGE_PROVIDER === "gcs") {
    if (env.S3_BUCKET) {
      throw new Error("S3_BUCKET is set but STORAGE_PROVIDER is gcs: unset S3_BUCKET");
    }
    if (!env.GCS_BUCKET) {
      throw new Error("STORAGE_PROVIDER=gcs needs GCS_BUCKET");
    }
    return env.GCS_BUCKET;
  }
  if (env.GCS_BUCKET) {
    throw new Error(
      "GCS_BUCKET is set but STORAGE_PROVIDER is s3: set STORAGE_PROVIDER=gcs, or unset GCS_BUCKET",
    );
  }
  return env.S3_BUCKET;
}

/** Whether uploads are on: the chosen provider has its bucket (see `storageBucket`). */
export function filesEnabled(env: StorageChoice) {
  return storageBucket(env) !== undefined;
}

/** The configured storage, or null when files are off (no bucket for the chosen provider). */
export function createStorage(
  env: StorageChoice & {
    S3_REGION: string;
    S3_ENDPOINT?: string | undefined;
    S3_ACCESS_KEY_ID?: string | undefined;
    S3_SECRET_ACCESS_KEY?: string | undefined;
    S3_FORCE_PATH_STYLE: boolean;
  },
): Storage | null {
  const bucket = storageBucket(env);
  if (!bucket) {
    return null;
  }
  if (env.STORAGE_PROVIDER === "gcs") {
    return new GcsStorage({ bucket });
  }
  return new S3Storage({
    bucket,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    ...(env.S3_ACCESS_KEY_ID && { accessKeyId: env.S3_ACCESS_KEY_ID }),
    ...(env.S3_SECRET_ACCESS_KEY && { secretAccessKey: env.S3_SECRET_ACCESS_KEY }),
  });
}

export const STORAGE = Symbol("STORAGE");
