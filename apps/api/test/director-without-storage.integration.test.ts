/**
 * Director with uploads off (no S3_BUCKET), against a stand-in for the AI service: a
 * plan's captured audio is still listed as captured, with no link to it, and a seed's
 * media goes unlinked, rather than the library or the plan failing. (A separate file: it
 * needs a server started with storage unconfigured.)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { required } from "@repo/contracts/objects";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

let harness: Harness;
let ai: Server;
let aiRequests = 0;

// A committed seed, whose media would be linked if uploads were on.
const seed = required(directorSeeds[0], "a committed seed");

/** A cut, as the AI service answers it; its file is made by the test that publishes it. */
const cut = {
  id: randomUUID(),
  planId: randomUUID(),
  videoId: seed.videoId,
  templateTitle: "Seed singer",
  title: "Mine",
  picks: [],
  fileId: randomUUID(),
  durationMs: 1000,
  publishStatus: "none",
  youtubeVideoId: null,
  visibility: null,
  createdAt: "2026-10-18T10:00:00Z",
};
const plan = {
  id: randomUUID(),
  videoId: seed.videoId,
  source: "seed",
  status: "ready",
  stage: "ready",
  error: null,
  plan: seed.plan,
  model: "gemini-test",
  audioStatus: "ready",
  audioKey: `seed-audio/${seed.videoId}.m4a`,
  createdAt: "2026-10-18T10:00:00Z",
  updatedAt: "2026-10-18T10:00:00Z",
};

beforeAll(async () => {
  // The library, the one plan and a cut to publish are all this file asks the AI
  // service for.
  ai = createServer((request, response) => {
    aiRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    const url = request.url ?? "";
    const library = { templates: [plan], indexUsed: false };
    const answers: [string, object][] = [
      ["/v1/director/cuts/", cut],
      ["/v1/director/plans/", plan],
    ];
    const answer = answers.find(([path]) => url.startsWith(path))?.[1] ?? library;
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  delete process.env.S3_BUCKET;
  harness = await startApi(25, {
    S3_BUCKET: "",
    GOOGLE_CLIENT_ID: "director-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "director-test-secret",
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: `test-ai-secret-${randomUUID()}`,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

describe("Director without uploads", () => {
  it("lists a template's captured audio and its media with no link to either", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "No files" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const { templates } = await session.rpc.director.library();
    expect(templates.map((template) => template.audio)).toEqual([{ status: "ready", url: null }]);
    const one = await session.rpc.director.plan({ videoId: seed.videoId });
    expect(one.audio).toEqual({ status: "ready", url: null });
    expect(one.plan).not.toHaveProperty("musicUrl");
    expect(one.plan?.shots[0]).not.toHaveProperty("storyboardUrl");
    expect(one.plan?.shots[0]).not.toHaveProperty("previewUrl");
  });

  it("has no voice of its own: there's nowhere to keep a spoken line", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "No voice" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const asked = aiRequests;
    const error = await session.rpc.director
      .speak({ text: "Step back.", voice: "Puck" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "FEATURE_DISABLED",
      data: { params: { feature: "files" } },
    });
    // The model is never asked for a line the browser would then have no link to.
    expect(aiRequests).toBe(asked);
  });

  it("can't publish a cut, with nowhere to read its video from", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "No upload" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const me = await session.rpc.user.me();
    // The cut's video is a checked upload of theirs, made while uploads were on.
    const db = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await db.connect();
    await db.query(
      `INSERT INTO files.file (id, user_id, purpose, status, filename, declared_type,
                               declared_size, content_type, size, ready_at, updated_at)
       VALUES ($1, $2, 'director-cut-video', 'ready', 'cut.mp4', 'video/mp4', 10, 'video/mp4',
               10, now(), now())`,
      [cut.fileId, me.id],
    );
    await db.end();
    const error = await session.rpc.publish
      .upload({ cutId: cut.id, title: "Mine", description: "", hashtags: [], credits: "" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "FEATURE_DISABLED",
      data: { params: { feature: "files" } },
    });
  });
});
