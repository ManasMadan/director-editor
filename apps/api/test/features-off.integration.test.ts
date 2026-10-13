/**
 * Optional features are off without their configuration: the procedures say so, and
 * clients read the same from system.info to hide them. (A separate file: it needs a
 * server started with storage, billing, AI and web push all unconfigured.)
 */
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { createProducer } from "@repo/jobs";
import { eventually } from "@repo/testing/eventually";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

let harness: Harness;
beforeAll(async () => {
  delete process.env.S3_BUCKET;
  harness = await startApi(7, { S3_BUCKET: "", VAPID_PUBLIC_KEY: "" });
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
      features: { google: false, ai: false, captcha: false, files: false, billing: false },
      captchaSiteKey: null,
      webPushPublicKey: null,
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

  it("answers FEATURE_DISABLED for the AI features", async () => {
    const session = await signedIn();
    const error = await expectError(
      session.rpc.ai.sentiment({ text: "Great" }),
      "FEATURE_DISABLED",
    );
    expect(error.data?.params).toEqual({ feature: "ai" });
  });

  it("without billing, every workspace has everything and there's nothing to pay", async () => {
    const session = await signedIn();
    expect(await session.rpc.billing.overview()).toMatchObject({
      enabled: false,
      plan: "pro",
      entitlements: { members: null, webhooks: true },
      subscription: null,
    });
    const error = await expectError(
      session.rpc.billing.checkout({ interval: "month" }),
      "FEATURE_DISABLED",
    );
    expect(error.data?.params).toEqual({ feature: "billing" });
  });

  it("without billing, billing events are taken and ignored", async () => {
    const events = createProducer("events-billing", harness.redis);
    const id = randomUUID();
    const job: Job = await events.add(
      "event",
      {
        id,
        name: "stripe.event_received.v1",
        key: "evt_off",
        payload: {
          inboundEventId: randomUUID(),
          stripeEventId: "evt_off",
          type: "customer.subscription.updated",
          object: { id: "sub_off" },
        },
        orgId: null,
        actorId: null,
        requestId: null,
        occurredAt: new Date().toISOString(),
        source: "webhooks",
      },
      { jobId: id },
    );
    const state = await eventually(
      () => job.getState(),
      (current) => current === "completed" || current === "failed",
    );
    await events.queue.close();
    expect(state).toBe("completed");
  });
});
