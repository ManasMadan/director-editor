import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** register(), with the environment read again (src/env.ts parses it on import). */
async function startWith(variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const { register } = await import("./instrumentation");
  return register;
}

it("starts a deployed site with the mobile app's links off", async () => {
  // .env.example sets none of the app's variables.
  const register = await startWith({ WEB_URL: "https://app.example.com" });
  expect(() => register()).not.toThrow();
});

it("refuses to start with only some of the app's variables", async () => {
  const register = await startWith({ APPLE_TEAM_ID: "ABCDE12345" });
  expect(() => register()).toThrow(
    "missing: IOS_BUNDLE_ID, ANDROID_PACKAGE, ANDROID_CERT_FINGERPRINTS",
  );
});
