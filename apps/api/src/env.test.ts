/** The API refuses to start on configuration that's wrong, or unsafe in production. */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    vi.stubEnv(name, value);
  }
  const { env } = await import("./env");
  const { features } = await import("./features");
  return { env, features };
}

describe("the environment", () => {
  it("listens on API_PORT from the local .env, on PORT over it, else on 3001", async () => {
    const listensOn = async (variables: Record<string, string>) => {
      vi.resetModules();
      return (await load(variables)).env.PORT;
    };
    expect(await listensOn({ PORT: "", API_PORT: "4101" })).toBe(4101);
    expect(await listensOn({ PORT: "4200", API_PORT: "4101" })).toBe(4200);
    expect(await listensOn({ PORT: "", API_PORT: "" })).toBe(3001);
  });

  it("parses versioned auth secrets, and refuses malformed ones", async () => {
    const { env } = await load({ BETTER_AUTH_SECRETS: `2:${"n".repeat(40)}` });
    expect(env.BETTER_AUTH_SECRETS).toEqual([{ version: 2, value: "n".repeat(40) }]);
    vi.resetModules();
    await expect(load({ BETTER_AUTH_SECRETS: "not-versioned" })).rejects.toThrow(
      "Invalid environment variables",
    );
  });

  it.each([
    [
      "the mock Google's YouTube",
      { YOUTUBE_API_URL: "http://localhost:12112/youtube/v3" },
      "YOUTUBE_API_URL must be HTTPS in production",
    ],
    [
      "a pasted Google access token",
      {
        WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "",
        YOUTUBE_API_URL: "https://www.googleapis.com/youtube/v3",
        GOOGLE_ACCESS_TOKEN: "ya29.token",
      },
      "GOOGLE_ACCESS_TOKEN is for local development only",
    ],
  ])("refuses %s in production", async (_, variables, message) => {
    await expect(load({ NODE_ENV: "production", ...variables })).rejects.toThrow(message);
  });
});

describe("optional features", () => {
  it("are off without their configuration", async () => {
    const { features } = await load({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    expect(features).toMatchObject({ google: false });
  });

  it("are on with all of it", async () => {
    const { features } = await load({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
    expect(features).toMatchObject({ google: true });
  });

  it("turn files on with the chosen storage provider's bucket, whichever provider it is", async () => {
    expect((await load({ STORAGE_PROVIDER: "s3", S3_BUCKET: "uploads" })).features.files).toBe(
      true,
    );
    vi.resetModules();
    vi.unstubAllEnvs();
    const gcs = await load({
      STORAGE_PROVIDER: "gcs",
      S3_BUCKET: "",
      GCS_BUCKET: "director-media",
    });
    expect(gcs.features.files).toBe(true);
    vi.resetModules();
    vi.unstubAllEnvs();
    expect((await load({ STORAGE_PROVIDER: "s3", S3_BUCKET: "" })).features.files).toBe(false);
  });

  it.each([
    [
      "Google sign-in",
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" },
      "Google sign-in (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) needs both of its variables set, or neither",
    ],
    [
      "Cloud Storage without its bucket",
      { STORAGE_PROVIDER: "gcs", S3_BUCKET: "", GCS_BUCKET: "" },
      "STORAGE_PROVIDER=gcs needs GCS_BUCKET",
    ],
    [
      "a Cloud Storage bucket with the S3 provider",
      { STORAGE_PROVIDER: "s3", GCS_BUCKET: "director-media" },
      "GCS_BUCKET is set but STORAGE_PROVIDER is s3",
    ],
  ])("refuse to start %s half configured", async (_, variables, message) => {
    await expect(load(variables)).rejects.toThrow(message);
  });

  it("checks passwords against public breaches in production unless told not to", async () => {
    // Production as it would be: without the local stand-ins the example sets.
    const production = {
      NODE_ENV: "production",
      // .env.example points at the local mock Google, which production refuses.
      YOUTUBE_API_URL: "https://www.googleapis.com/youtube/v3",
    };
    expect((await load(production)).env.PASSWORD_BREACH_CHECK).toBe("on");
    vi.resetModules();
    vi.unstubAllEnvs();
    expect((await load({})).env.PASSWORD_BREACH_CHECK).toBe("off");
    vi.resetModules();
    const off = await load({ ...production, PASSWORD_BREACH_CHECK: "off" });
    expect(off.env.PASSWORD_BREACH_CHECK).toBe("off");
  });
});
