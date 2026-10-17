import { generateKeyPairSync } from "node:crypto";
import { Storage as GcsClient } from "@google-cloud/storage";
import { required } from "@repo/contracts/objects";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GcsClientLike, GcsFile } from "./storage";
import { createStorage, filesEnabled, GcsStorage, S3Storage, storageBucket } from "./storage";

afterEach(() => vi.unstubAllEnvs());

describe("object storage configuration", () => {
  it("is off without a bucket", () => {
    expect(
      createStorage({ STORAGE_PROVIDER: "s3", S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: false }),
    ).toBeNull();
  });

  it("talks to AWS with virtual-hosted buckets unless told otherwise", async () => {
    // No keys given: the SDK's own chain finds them (here the environment, in a cluster
    // the pod's role).
    vi.stubEnv("AWS_ACCESS_KEY_ID", "from-the-environment");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    const aws = new S3Storage({ bucket: "uploads", region: "eu-west-1" });
    const { url } = await aws.presignDownload("files/a", { filename: 'my "report".pdf' });
    const signed = new URL(url);
    expect(signed.host).toBe("uploads.s3.eu-west-1.amazonaws.com");
    expect(signed.pathname).toBe("/files/a");
    expect(signed.searchParams.get("X-Amz-Credential")).toMatch(/^from-the-environment\//);
    // Downloads never render in our origin, and the name can't break out of its quotes.
    expect(signed.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="my report.pdf"',
    );
  });

  it("uses the configured endpoint and path-style buckets for RustFS and the like", async () => {
    const storage = createStorage({
      STORAGE_PROVIDER: "s3",
      S3_BUCKET: "uploads",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "http://localhost:59000",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_FORCE_PATH_STYLE: true,
    });
    const { url } = (await storage?.presignDownload("files/a")) ?? { url: "" };
    expect(url).toMatch(/^http:\/\/localhost:59000\/uploads\/files\/a\?/);
    expect(new URL(url).searchParams.get("X-Amz-Credential")).toMatch(/^key\//);
  });

  it("has no direct URI on S3 (nothing else in the project can read it without a presigned URL)", () => {
    const s3 = new S3Storage({ bucket: "uploads", region: "us-east-1" });
    expect(s3.directUri("files/a")).toBeNull();
  });

  it("picks GcsStorage when the provider is gcs and a bucket is set", () => {
    const storage = createStorage({
      STORAGE_PROVIDER: "gcs",
      GCS_BUCKET: "director-media",
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: false,
    });
    expect(storage).toBeInstanceOf(GcsStorage);
  });

  it("turns files on exactly when the chosen provider has its bucket", () => {
    expect(storageBucket({ STORAGE_PROVIDER: "s3", S3_BUCKET: "uploads" })).toBe("uploads");
    expect(storageBucket({ STORAGE_PROVIDER: "s3" })).toBeUndefined();
    expect(storageBucket({ STORAGE_PROVIDER: "gcs", GCS_BUCKET: "director-media" })).toBe(
      "director-media",
    );
    expect(filesEnabled({ STORAGE_PROVIDER: "s3", S3_BUCKET: "uploads" })).toBe(true);
    expect(filesEnabled({ STORAGE_PROVIDER: "gcs", GCS_BUCKET: "director-media" })).toBe(true);
    expect(filesEnabled({ STORAGE_PROVIDER: "s3" })).toBe(false);
  });

  it.each([
    [
      "gcs without its bucket",
      { STORAGE_PROVIDER: "gcs" as const },
      "STORAGE_PROVIDER=gcs needs GCS_BUCKET",
    ],
    [
      "a GCS bucket with the s3 provider",
      { STORAGE_PROVIDER: "s3" as const, GCS_BUCKET: "director-media" },
      "GCS_BUCKET is set but STORAGE_PROVIDER is s3",
    ],
    [
      "an S3 bucket with the gcs provider",
      { STORAGE_PROVIDER: "gcs" as const, GCS_BUCKET: "director-media", S3_BUCKET: "uploads" },
      "S3_BUCKET is set but STORAGE_PROVIDER is gcs",
    ],
  ])("refuses %s, instead of silently turning files off or ignoring it", (_, env, message) => {
    expect(() => storageBucket(env)).toThrow(message);
    expect(() => filesEnabled(env)).toThrow(message);
    expect(() =>
      createStorage({ ...env, S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: false }),
    ).toThrow(message);
  });
});

/** A fake `@google-cloud/storage` client: records every call, answers what the test sets up. */
class FakeGcsClient implements GcsClientLike {
  readonly signedUrlConfigs: Parameters<GcsFile["getSignedUrl"]>[0][] = [];
  readonly requestedKeys: string[] = [];
  /** The generation each download asked for (undefined: whatever is live). */
  readonly downloads: (string | number | undefined)[] = [];
  metadata: { size?: string | number; contentType?: string; generation?: string | number } = {};

  bucket(name: string) {
    expect(name).toBe("director-media");
    return {
      file: (key: string, options?: { generation?: string | number }) => {
        this.requestedKeys.push(key);
        return this.fakeFile(options?.generation);
      },
    };
  }

  private fakeFile(generation: string | number | undefined): GcsFile {
    return {
      getSignedUrl: async (config) => {
        this.signedUrlConfigs.push(config);
        return [`https://storage.googleapis.com/signed?action=${config.action}`];
      },
      getMetadata: async () => [this.metadata],
      download: async () => {
        this.downloads.push(generation);
        return [Buffer.from("take bytes")];
      },
      save: async () => undefined,
      rename: async () => undefined,
      delete: async () => undefined,
    };
  }
}

describe("GcsStorage", () => {
  it("signs an upload for the right object key, content type and expiry", async () => {
    const client = new FakeGcsClient();
    const storage = new GcsStorage({ bucket: "director-media", client });
    const before = Date.now();
    const upload = await storage.presignUpload({
      key: "files/take-1",
      contentType: "video/webm",
      contentLength: 1_200_000,
      expiresInSeconds: 600,
    });
    expect(client.requestedKeys).toEqual(["files/take-1"]);
    expect(client.signedUrlConfigs).toEqual([
      expect.objectContaining({
        version: "v4",
        action: "write",
        contentType: "video/webm",
        // Signed, so the URL can't be reused to upload a file of any other size.
        extensionHeaders: { "content-length": "1200000" },
      }),
    ]);
    const config = required(client.signedUrlConfigs[0], "the signed URL's config");
    expect(config.expires.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(upload.headers).toEqual({
      "Content-Type": "video/webm",
      "Content-Length": "1200000",
    });
    expect(upload.expiresAt.getTime()).toBe(config.expires.getTime());
    expect(upload.url).toBe("https://storage.googleapis.com/signed?action=write");
  });

  it("signs a download for the right object key and expiry, and names the file to save as", async () => {
    const client = new FakeGcsClient();
    const storage = new GcsStorage({ bucket: "director-media", client });
    const before = Date.now();
    const { url, expiresAt } = await storage.presignDownload("files/take-1", {
      filename: 'my "take".webm',
      expiresInSeconds: 120,
    });
    expect(client.requestedKeys).toEqual(["files/take-1"]);
    expect(client.signedUrlConfigs).toEqual([
      expect.objectContaining({
        version: "v4",
        action: "read",
        responseDisposition: 'attachment; filename="my take.webm"',
      }),
    ]);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(url).toBe("https://storage.googleapis.com/signed?action=read");
  });

  it("signs a download with no disposition when no filename is given", async () => {
    const client = new FakeGcsClient();
    const storage = new GcsStorage({ bucket: "director-media", client });
    await storage.presignDownload("files/take-1");
    expect(client.signedUrlConfigs).toEqual([
      expect.not.objectContaining({ responseDisposition: expect.anything() }),
    ]);
  });

  it("reports an object's size and content type", async () => {
    const client = new FakeGcsClient();
    client.metadata = { size: "48213", contentType: "image/jpeg" };
    const storage = new GcsStorage({ bucket: "director-media", client });
    expect(await storage.head("files/a")).toEqual({ size: 48_213, contentType: "image/jpeg" });
  });

  it("reports no object for a 404", async () => {
    const client = new FakeGcsClient();
    client.bucket = () => ({
      file: () => ({
        getSignedUrl: () => Promise.reject(new Error("unused")),
        getMetadata: () => {
          const error = Object.assign(new Error("not found"), { code: 404 });
          return Promise.reject(error);
        },
        download: () => Promise.reject(new Error("unused")),
        save: () => Promise.reject(new Error("unused")),
        rename: () => Promise.reject(new Error("unused")),
        delete: () => Promise.reject(new Error("unused")),
      }),
    });
    const storage = new GcsStorage({ bucket: "director-media", client });
    expect(await storage.head("files/missing")).toBeNull();
  });

  it("rethrows anything other than a 404", async () => {
    const client = new FakeGcsClient();
    client.bucket = () => ({
      file: () => ({
        getSignedUrl: () => Promise.reject(new Error("unused")),
        getMetadata: () => Promise.reject(new Error("boom")),
        download: () => Promise.reject(new Error("unused")),
        save: () => Promise.reject(new Error("unused")),
        rename: () => Promise.reject(new Error("unused")),
        delete: () => Promise.reject(new Error("unused")),
      }),
    });
    const storage = new GcsStorage({ bucket: "director-media", client });
    await expect(storage.head("files/a")).rejects.toThrow("boom");
  });

  it("reads an object within the limit, at the generation whose size it checked", async () => {
    const client = new FakeGcsClient();
    client.metadata = { size: 10, generation: "1712345678901234" };
    const storage = new GcsStorage({ bucket: "director-media", client });
    expect((await storage.read("files/a", 100)).toString()).toBe("take bytes");
    // An upload replacing the object in between can't slip a larger one past the check.
    expect(client.downloads).toEqual(["1712345678901234"]);
  });

  it("refuses to read an object over the limit, without downloading it", async () => {
    const client = new FakeGcsClient();
    client.metadata = { size: 10, generation: 1 };
    const storage = new GcsStorage({ bucket: "director-media", client });
    await expect(storage.read("files/a", 5)).rejects.toThrow("larger than 5 bytes");
    expect(client.downloads).toEqual([]);
  });

  it("writes, moves and deletes an object", async () => {
    const client = new FakeGcsClient();
    const storage = new GcsStorage({ bucket: "director-media", client });
    await expect(storage.write("files/a", Buffer.from("x"), "image/jpeg")).resolves.toBeUndefined();
    await expect(storage.move("quarantine/a", "files/a")).resolves.toBeUndefined();
    await expect(storage.delete("files/a")).resolves.toBeUndefined();
  });

  it("gives a direct gs:// reference another Google service can read with its own credentials", () => {
    const storage = new GcsStorage({ bucket: "director-media", client: new FakeGcsClient() });
    expect(storage.directUri("files/a")).toBe("gs://director-media/files/a");
  });
});

describe("GcsStorage with the real @google-cloud/storage client", () => {
  // A service account key made up here: signing is local with a private key, so nothing
  // leaves the machine (in production the key-less metadata credentials sign through the
  // IAM Credentials API instead, which the fake-client tests above stand in for).
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const client = new GcsClient({
    projectId: "director-test",
    credentials: {
      client_email: "media@director-test.iam.gserviceaccount.com",
      private_key: privateKey,
    },
  });

  it("signs an upload URL bound to the object, its type, its exact size and the expiry", async () => {
    const storage = new GcsStorage({ bucket: "director-media", client });
    const { url } = await storage.presignUpload({
      key: "files/take-1",
      contentType: "video/webm",
      contentLength: 1_200_000,
      expiresInSeconds: 600,
    });
    const signed = new URL(url);
    expect(`${signed.origin}${signed.pathname}`).toBe(
      "https://storage.googleapis.com/director-media/files/take-1",
    );
    expect(signed.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(signed.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    expect(signed.searchParams.get("X-Goog-Expires")).toBe("600");
    expect(signed.searchParams.get("X-Goog-Signature")).toMatch(/^[0-9a-f]+$/);
  });

  it("signs a download URL for the object and the expiry", async () => {
    const storage = new GcsStorage({ bucket: "director-media", client });
    const { url } = await storage.presignDownload("files/take-1", { expiresInSeconds: 120 });
    const signed = new URL(url);
    expect(signed.pathname).toBe("/director-media/files/take-1");
    expect(signed.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
    expect(signed.searchParams.get("X-Goog-Expires")).toBe("120");
  });
});
