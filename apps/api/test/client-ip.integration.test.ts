/**
 * Rate limits must key on the real client IP. Here the API trusts no proxy (the test
 * connects from loopback, which is not in TRUSTED_PROXIES), so X-Forwarded-For is a
 * client-written header and must be ignored: rotating it can't buy more attempts.
 * Separate file because the API reads its environment once per module graph.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSession, type Harness, newEmail, startApi } from "./harness";

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(8, { TRUSTED_PROXIES: "192.0.2.1" });
});
afterAll(() => harness?.close());

it("ignores a spoofed X-Forwarded-For from an untrusted peer", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    // A fresh session per attempt means a fresh random X-Forwarded-For each time.
    const attempt = await createSession(harness).auth("/sign-in/email", {
      email: newEmail(),
      password: "wrong-password-1",
    });
    statuses.push(attempt.status);
  }
  expect(statuses.at(-1)).toBe(429);
});
