import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** env.ts as a fresh process would load it, with these variables. */
async function load(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) {
    vi.stubEnv(key, value);
  }
  return (await import("./env")).env;
}

describe("worker environment", () => {
  it("listens on WORKER_PORT from the local .env, on PORT over it, else on 3002", async () => {
    const listensOn = async (variables: Record<string, string>) => {
      vi.resetModules();
      return (await load(variables)).PORT;
    };
    expect(await listensOn({ PORT: "", WORKER_PORT: "4102" })).toBe(4102);
    expect(await listensOn({ PORT: "4200", WORKER_PORT: "4102" })).toBe(4200);
    expect(await listensOn({ PORT: "", WORKER_PORT: "" })).toBe(3002);
  });

  it("lets development skip virus scanning", async () => {
    const env = await load({ S3_BUCKET: "uploads", FILE_SCANNER: "none" });
    expect(env.FILE_SCANNER).toBe("none");
  });

  it("refuses to take uploads in production without scanning them", async () => {
    await expect(
      load({ NODE_ENV: "production", S3_BUCKET: "uploads", FILE_SCANNER: "none" }),
    ).rejects.toThrow("FILE_SCANNER=none is for development only: uploads must be scanned");
    vi.resetModules();
    // Without files, there's nothing to scan.
    expect(
      (await load({ NODE_ENV: "production", S3_BUCKET: "", FILE_SCANNER: "none" })).S3_BUCKET,
    ).toBeUndefined();
  });

  it("refuses unscanned uploads on Cloud Storage too", async () => {
    await expect(
      load({
        NODE_ENV: "production",
        STORAGE_PROVIDER: "gcs",
        S3_BUCKET: "",
        GCS_BUCKET: "director-media",
        FILE_SCANNER: "none",
      }),
    ).rejects.toThrow("FILE_SCANNER=none is for development only: uploads must be scanned");
  });

  it.each([
    [
      { STORAGE_PROVIDER: "gcs", S3_BUCKET: "", GCS_BUCKET: "" },
      "STORAGE_PROVIDER=gcs needs GCS_BUCKET",
    ],
    [
      { STORAGE_PROVIDER: "s3", S3_BUCKET: "uploads", GCS_BUCKET: "director-media" },
      "GCS_BUCKET is set but STORAGE_PROVIDER is s3",
    ],
  ])(
    "refuses half-configured storage at boot, in development too (%o)",
    async (variables, message) => {
      await expect(load({ NODE_ENV: "development", ...variables })).rejects.toThrow(message);
    },
  );
});
