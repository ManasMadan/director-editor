import { afterEach, describe, expect, it, vi } from "vitest";
import type { GcsClientLike, GcsFile } from "./storage";
import { createStorage, GcsStorage, S3Storage } from "./storage";

afterEach(() => vi.unstubAllEnvs());

describe("object storage configuration", () => {
  it("is off without a bucket for the chosen provider", () => {
    expect(
      createStorage({ STORAGE_PROVIDER: "s3", S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: false }),
    ).toBeNull();
    expect(
      createStorage({
        STORAGE_PROVIDER: "gcs",
        S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: false,
      }),
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
});

/** A fake `@google-cloud/storage` client: records every call, answers what the test sets up. */
class FakeGcsClient implements GcsClientLike {
  readonly signedUrlConfigs: unknown[] = [];
  readonly requestedKeys: string[] = [];
  metadata: { size?: string | number; contentType?: string } = {};

  bucket(name: string) {
    expect(name).toBe("director-media");
    return {
      file: (key: string) => {
        this.requestedKeys.push(key);
        return this.fakeFile();
      },
    };
  }

  private fakeFile(): GcsFile {
    return {
      getSignedUrl: async (config) => {
        this.signedUrlConfigs.push(config);
        return [`https://storage.googleapis.com/signed?action=${config.action}`];
      },
      getMetadata: async () => [this.metadata],
      download: async () => [Buffer.from("take bytes")],
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
      expect.objectContaining({ version: "v4", action: "write", contentType: "video/webm" }),
    ]);
    const config = client.signedUrlConfigs[0] as { expires: Date };
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

  it("reads an object within the limit", async () => {
    const client = new FakeGcsClient();
    client.metadata = { size: 10 };
    const storage = new GcsStorage({ bucket: "director-media", client });
    expect((await storage.read("files/a", 100)).toString()).toBe("take bytes");
  });

  it("refuses to read an object over the limit, without downloading it", async () => {
    const client = new FakeGcsClient();
    client.metadata = { size: 10 };
    const storage = new GcsStorage({ bucket: "director-media", client });
    await expect(storage.read("files/a", 5)).rejects.toThrow("larger than 5 bytes");
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
