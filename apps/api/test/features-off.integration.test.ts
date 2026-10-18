/**
 * Optional features are off without their configuration: the procedures say so, and
 * clients read the same from system.info to hide them. (A separate file: it needs a
 * server started with storage and AI unconfigured.)
 */
import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

let harness: Harness;
beforeAll(async () => {
  delete process.env.S3_BUCKET;
  harness = await startApi(7, { S3_BUCKET: "" });
});
afterAll(() => harness?.close());

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Off" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return session;
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, { params?: unknown }>).code).toBe(code);
  return error as ORPCError<string, { params?: unknown }>;
}

describe("features off", () => {
  it("reports every optional feature off, with no keys for the browser", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info).toMatchObject({
      features: {
        google: false,
        ai: false,
        captcha: false,
        director: false,
        files: false,
      },
      captchaSiteKey: null,
    });
  });

  it("answers FEATURE_DISABLED for uploads", async () => {
    const session = await signedIn();
    await expectError(
      session.rpc.files.createUpload({
        purpose: "avatar",
        filename: "x.png",
        contentType: "image/png",
        size: 10,
      }),
      "FEATURE_DISABLED",
    );
  });

  it("answers FEATURE_DISABLED for Director's plans without the AI service", async () => {
    const session = await signedIn();
    const error = await expectError(
      session.rpc.director.plan({ videoId: "dQw4w9WgXcQ" }),
      "FEATURE_DISABLED",
    );
    expect(error.data?.params).toEqual({ feature: "ai" });
  });

  it("answers FEATURE_DISABLED for indexing a short without a YouTube key", async () => {
    const session = await signedIn();
    const error = await expectError(
      session.rpc.director.index({ url: "https://youtu.be/dQw4w9WgXcQ" }),
      "FEATURE_DISABLED",
    );
    expect(error.data?.params).toEqual({ feature: "director" });
  });
});
