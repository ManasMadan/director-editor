import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorage, S3Storage } from "./storage";

afterEach(() => vi.unstubAllEnvs());

describe("object storage configuration", () => {
  it("is off without a bucket", () => {
    expect(createStorage({ S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: false })).toBeNull();
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
});
