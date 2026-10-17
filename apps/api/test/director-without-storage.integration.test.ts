/**
 * Director with uploads off (no S3_BUCKET), against a stand-in for the AI service: a
 * plan's captured audio is still listed as captured, with no link to it, rather than the
 * library failing. (A separate file: it needs a server started with storage unconfigured.)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

let harness: Harness;
let ai: Server;

const plan = {
  id: randomUUID(),
  videoId: "SeedSinger1",
  source: "seed",
  status: "pending",
  stage: "queued",
  error: null,
  plan: null,
  model: null,
  audioStatus: "ready",
  audioKey: "seed-audio/SeedSinger1.m4a",
  createdAt: "2026-10-18T10:00:00Z",
  updatedAt: "2026-10-18T10:00:00Z",
};

beforeAll(async () => {
  // The library is all this file asks the AI service for.
  ai = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ templates: [plan], indexUsed: false }));
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  delete process.env.S3_BUCKET;
  harness = await startApi(25, {
    S3_BUCKET: "",
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: `test-ai-secret-${randomUUID()}`,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

describe("Director without uploads", () => {
  it("lists a template's captured audio with no link to it", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "No files" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const { templates } = await session.rpc.director.library();
    expect(templates.map((template) => template.audio)).toEqual([{ status: "ready", url: null }]);
  });
});
