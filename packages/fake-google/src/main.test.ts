import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("running the mock Google", () => {
  it("starts on GOOGLE_FAKE_PORT with the one key both APIs share", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "k");
    vi.stubEnv("YOUTUBE_API_KEY", "k");
    vi.stubEnv("GOOGLE_FAKE_PORT", "0");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { fake } = await import("./main");
    expect(write).toHaveBeenCalledWith(`mock Google (Gemini and YouTube) on ${fake.url}\n`);
    await fake.close();
  });

  it("needs its key, and the same key for both", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    await expect(import("./main")).rejects.toThrow("GOOGLE_API_KEY must be set");
    vi.resetModules();
    vi.stubEnv("GOOGLE_API_KEY", "a");
    vi.stubEnv("YOUTUBE_API_KEY", "b");
    await expect(import("./main")).rejects.toThrow("one key");
  });
});
