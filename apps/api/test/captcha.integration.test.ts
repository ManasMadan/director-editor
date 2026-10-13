/**
 * With Turnstile configured, the protected auth endpoints refuse requests without a
 * captcha token, and clients learn the public site key from system.info. (Separate
 * file: the API reads its environment once per module graph.) Tokens are checked with
 * Cloudflare, so the "valid token" path is covered by the web e2e captcha test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi } from "./harness";

// Cloudflare's published always-pass test keys.
const SITE_KEY = "1x00000000000000000000AA";
const SECRET_KEY = "1x0000000000000000000000000000000AA";

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(9, { TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: SECRET_KEY });
});
afterAll(() => harness?.close());

describe("captcha", () => {
  it("publishes the site key and marks the feature on", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.features.captcha).toBe(true);
    expect(info.captchaSiteKey).toBe(SITE_KEY);
  });

  it.each([
    ["/sign-up/email", () => ({ email: newEmail(), password: newPassword(), name: "Bot" })],
    ["/email-otp/send-verification-otp", () => ({ email: newEmail(), type: "email-verification" })],
    ["/email-otp/request-password-reset", () => ({ email: newEmail() })],
  ])("%s needs a captcha token", async (path, body) => {
    const response = await createSession(harness).auth(path, body());
    expect(response.status).toBe(400);
  });

  it("sign-in itself isn't gated (it's rate limited instead)", async () => {
    const response = await createSession(harness).auth("/sign-in/email", {
      email: newEmail(),
      password: "wrong-password-1",
    });
    expect(response.status).toBe(401);
  });
});
