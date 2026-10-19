/**
 * Which auth forms ask for a captcha once Turnstile is configured: the ones that make an
 * account or send a code, and a demo guest's sign-in only while demo guests are on. The
 * plugins run in better-auth itself, on its in-memory store, and are asked before any
 * route: a gated form without a token is refused there, anything else goes on to its
 * route.
 */
import { betterAuth } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Better-auth with only the captcha plugins, as the API configures them for `variables`. */
async function withCaptcha(variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    vi.stubEnv(name, value);
  }
  const { env } = await import("../env");
  const { captchaPlugins } = await import("./auth-plugins");
  const auth = betterAuth({
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:3001",
    plugins: captchaPlugins(env),
  });
  return async (path: string) => {
    const response = await auth.handler(
      new Request(`http://localhost:3001/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    return response.status;
  };
}

const TURNSTILE = {
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

describe("the captcha", () => {
  it("gates the forms that make an account or send a code, not a guest's sign-in without guests", async () => {
    const status = await withCaptcha({ ...TURNSTILE, DEMO_GUESTS: "" });
    expect(await status("/sign-up/email")).toBe(400);
    expect(await status("/email-otp/send-verification-otp")).toBe(400);
    expect(await status("/email-otp/request-password-reset")).toBe(400);
    expect(await status("/sign-in/guest")).toBe(404);
  });

  it("gates a guest's sign-in too while demo guests are on", async () => {
    const status = await withCaptcha({ ...TURNSTILE, DEMO_GUESTS: "on" });
    expect(await status("/sign-in/guest")).toBe(400);
  });
});
