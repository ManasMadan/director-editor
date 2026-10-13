/**
 * The Shorts feed and Director through the API, against strict stand-ins for YouTube's
 * Data API and for the Python AI service (which checks the per-call token the API signs).
 * The real AI service is covered by its own tests (apps/ai/tests/test_director.py).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  startApi,
  takeOtp,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;
const KEY = "test-youtube-key";
const VIDEO = "dQw4w9WgXcQ";
const LONG = "LongVideo01";
const GONE = "GoneVideo01";

let harness: Harness;
let youtube: Server;
let ai: Server;
const youtubeCalls: URL[] = [];
const aiCalls: { route: string; org: string; user: string; body: unknown }[] = [];
/** The presigned read the AI service was last handed for a take. */
let lastSourceUrl = "";
/** What YouTube does next: answer, run out of quota, or have comments off. */
let youtubeMode: "ok" | "quota" | "comments-off" = "ok";

function video(id: string, duration: string) {
  return {
    id,
    snippet: {
      title: `Video ${id}`,
      channelTitle: "Creator",
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    },
    contentDetails: { duration },
    statistics: { viewCount: "1200", likeCount: "80", commentCount: "5" },
  };
}

const VIDEOS: Partial<Record<string, ReturnType<typeof video>>> = {
  [VIDEO]: video(VIDEO, "PT45S"),
  [LONG]: video(LONG, "PT4M2S"),
  short2: video("Short2xxxxx", "PT12S"),
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** YouTube Data API v3, as far as the API reads it. */
function youtubeRoute(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://youtube.test");
  youtubeCalls.push(url);
  if (url.searchParams.get("key") !== KEY) {
    return send(response, 400, { error: { code: 400, errors: [{ reason: "keyInvalid" }] } });
  }
  if (youtubeMode === "quota") {
    return send(response, 403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } });
  }
  if (url.pathname === "/search") {
    const page = url.searchParams.get("pageToken");
    return send(response, 200, {
      ...(page ? {} : { nextPageToken: "page-2" }),
      items: (page ? ["Short2xxxxx"] : [VIDEO, LONG]).map((id) => ({ id: { videoId: id } })),
    });
  }
  if (url.pathname === "/videos") {
    const ids = (url.searchParams.get("id") ?? "").split(",");
    const all: Partial<Record<string, ReturnType<typeof video>>> = {
      ...VIDEOS,
      Short2xxxxx: video("Short2xxxxx", "PT12S"),
    };
    return send(response, 200, { items: ids.flatMap((id) => all[id] ?? []) });
  }
  if (url.pathname === "/commentThreads") {
    if (youtubeMode === "comments-off") {
      return send(response, 403, {
        error: { code: 403, errors: [{ reason: "commentsDisabled" }] },
      });
    }
    return send(response, 200, {
      items: [
        {
          id: "c1",
          snippet: {
            topLevelComment: {
              snippet: {
                authorDisplayName: "Fan",
                textOriginal: "Love this trend",
                likeCount: 3,
                publishedAt: "2026-09-02T10:00:00Z",
              },
            },
          },
        },
      ],
    });
  }
  return send(response, 404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
}

const PLAN = {
  title: "Pen drop",
  format: "Shoe check",
  summary: "A dropped pen, a slow tilt down to the shoes, a look around.",
  audio: "music",
  durationSeconds: 9,
  shots: [
    {
      kind: "video",
      title: "The drop",
      purpose: "The pen falls; the camera follows it down.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 9,
      durationSeconds: 9,
      camera: "back",
      scene: "Anywhere with a clear floor",
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.2, y: 0.5, width: 0.6, height: 0.4 },
        note: "Shoes fill the bottom half.",
      },
      phoneAngle: { pitch: -60, roll: 0, tolerance: 10, height: "shoulder" },
      pose: { description: "No one in frame.", keypoints: [] },
      steps: [
        { atSeconds: 0, instruction: "Hold the phone by your shoulder.", cameraMove: "static" },
        { atSeconds: 2, instruction: "Drop your pen.", cameraMove: "down" },
      ],
      script: [],
    },
  ],
};

interface StandInPlan {
  id: string;
  org: string;
  videoId: string;
  status: string;
}
const plans: StandInPlan[] = [];
const takes: {
  id: string;
  org: string;
  user: string;
  videoId: string;
  shotIndex: number;
  fileId: string;
  kind: string;
}[] = [];

function planOut(plan: StandInPlan) {
  const now = new Date().toISOString();
  return {
    id: plan.id,
    videoId: plan.videoId,
    status: plan.status,
    error: null,
    plan: plan.status === "ready" ? PLAN : null,
    model: plan.status === "ready" ? "gemini-test" : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    : {};
}

async function caller(request: IncomingMessage) {
  try {
    const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: "api",
      audience: "ai",
      maxTokenAge: 120,
    });
    return { org: String(payload.org), user: String(payload.sub) };
  } catch {
    return undefined;
  }
}

/** The AI service's Director routes, per organization, as apps/ai answers them. */
async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const who = await caller(request);
  if (!who) {
    return send(response, 401, {});
  }
  const body = await readBody(request);
  const route = `${request.method} ${request.url}`;
  aiCalls.push({ route, ...who, body });
  const fail = (status: number, code: string) =>
    send(response, status, {
      defined: true,
      code,
      status,
      message: code,
      data: { params: {}, requestId: "r" },
    });
  const find = (videoId: string) => plans.find((p) => p.org === who.org && p.videoId === videoId);
  if (route === "POST /v1/director/plans") {
    const videoId = String(body.videoId);
    const plan = find(videoId) ?? { id: randomUUID(), org: who.org, videoId, status: "pending" };
    if (!plans.includes(plan)) {
      plans.push(plan);
    }
    return send(response, 200, planOut(plan));
  }
  const planMatch = /^GET \/v1\/director\/plans\/([\w-]{11})$/.exec(route);
  if (planMatch) {
    const plan = find(planMatch[1] ?? "");
    return plan ? send(response, 200, planOut(plan)) : fail(404, "DIRECTOR_PLAN_NOT_FOUND");
  }
  if (route === "POST /v1/director/scene-checks") {
    return send(response, 200, {
      inPlace: false,
      instruction: "Move about five meters left, to the tree.",
      direction: "left",
      distanceMeters: 5,
      landmark: { label: "tree", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 } },
      lighting: "good",
    });
  }
  if (route === "POST /v1/director/takes") {
    lastSourceUrl = String(body.sourceUrl);
    const take = {
      id: randomUUID(),
      org: who.org,
      user: who.user,
      videoId: String(body.videoId),
      shotIndex: Number(body.shotIndex),
      fileId: String(body.fileId),
      kind: String(body.kind),
    };
    takes.push(take);
    return send(response, 201, takeOut(take));
  }
  const takesMatch = /^GET \/v1\/director\/plans\/([\w-]{11})\/takes$/.exec(route);
  if (takesMatch) {
    return send(
      response,
      200,
      takes
        .filter((t) => t.org === who.org && t.user === who.user && t.videoId === takesMatch[1])
        .map(takeOut),
    );
  }
  return fail(404, "NOT_FOUND");
}

function takeOut(take: (typeof takes)[number]) {
  return {
    id: take.id,
    shotIndex: take.shotIndex,
    fileId: take.fileId,
    kind: take.kind,
    status: "pending",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    createdAt: new Date().toISOString(),
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  youtube = createServer(youtubeRoute);
  ai = createServer((request, response) => void aiRoute(request, response));
  harness = await startApi(24, {
    ...LOCAL_STORAGE,
    YOUTUBE_API_KEY: KEY,
    YOUTUBE_API_URL: await listen(youtube),
    AI_URL: await listen(ai),
    AI_SERVICE_SECRET: SECRET,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => youtube?.close(resolve));
  await new Promise((resolve) => ai?.close(resolve));
});

beforeEach(async () => {
  youtubeMode = "ok";
  // The API caches YouTube's answers; each test starts from YouTube itself.
  for (const key of await harness.redis.keys("cache:shorts:*")) {
    await harness.redis.del(key);
  }
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Director" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, me: await session.rpc.user.me() };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

async function sql(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query(query, params)).rows;
  } finally {
    await client.end();
  }
}

describe("the Shorts feed", () => {
  it("is on with YouTube and the AI service configured", async () => {
    const { session } = await signedIn();
    expect((await session.rpc.system.info()).features.director).toBe(true);
  });

  it("pages through YouTube's shorts, leaving out what's too long, from the cache the second time", async () => {
    const { session } = await signedIn();
    const first = await session.rpc.shorts.feed({ topic: "grwm" });
    expect(first.items.map((s) => s.videoId)).toEqual([VIDEO]);
    expect(first.items[0]).toMatchObject({
      durationSeconds: 45,
      viewCount: 1200,
      publishedAt: expect.any(Date),
    });
    expect(first.nextPageToken).toBe("page-2");
    const search = youtubeCalls.findLast((url) => url.pathname === "/search");
    expect(search?.searchParams.get("videoDuration")).toBe("short");
    expect(search?.searchParams.get("q")).toContain("grwm");

    const before = youtubeCalls.length;
    await expect(session.rpc.shorts.feed({ topic: "grwm" })).resolves.toEqual(first);
    expect(youtubeCalls.length).toBe(before);

    const second = await session.rpc.shorts.feed({ topic: "grwm", pageToken: "page-2" });
    expect(second).toEqual({
      items: [expect.objectContaining({ videoId: "Short2xxxxx" })],
      nextPageToken: null,
    });
  });

  it("finds a short from any kind of link, and says when there's none", async () => {
    const { session } = await signedIn();
    for (const url of [
      `https://www.youtube.com/shorts/${VIDEO}`,
      `youtube.com/watch?v=${VIDEO}`,
      `https://youtu.be/${VIDEO}`,
      VIDEO,
    ]) {
      await expect(session.rpc.shorts.lookup({ url })).resolves.toMatchObject({ videoId: VIDEO });
    }
    await expectError(
      session.rpc.shorts.lookup({ url: "https://example.com/watch?v=x" }),
      "SHORT_NOT_FOUND",
    );
    await expectError(session.rpc.shorts.get({ videoId: GONE }), "SHORT_NOT_FOUND");
  });

  it("reads comments, and says when they're off", async () => {
    const { session } = await signedIn();
    await expect(session.rpc.shorts.comments({ videoId: VIDEO })).resolves.toEqual({
      disabled: false,
      items: [
        expect.objectContaining({ author: "Fan", text: "Love this trend", authorImageUrl: null }),
      ],
    });
    youtubeMode = "comments-off";
    await expect(session.rpc.shorts.comments({ videoId: "Short2xxxxx" })).resolves.toEqual({
      disabled: true,
      items: [],
    });
  });

  it("turns YouTube's refusals into UPSTREAM_UNAVAILABLE", async () => {
    const { session } = await signedIn();
    youtubeMode = "quota";
    await expectError(session.rpc.shorts.feed({ topic: "dance" }), "UPSTREAM_UNAVAILABLE");
  });

  it("keeps each member's likes and saves, in their workspace only", async () => {
    const { session } = await signedIn();
    await expect(session.rpc.shorts.reactions({ videoId: VIDEO })).resolves.toEqual({
      liked: false,
      saved: false,
    });
    await session.rpc.shorts.react({ videoId: VIDEO, kind: "like", on: true });
    // Twice is the same as once.
    await expect(
      session.rpc.shorts.react({ videoId: VIDEO, kind: "save", on: true }),
    ).resolves.toEqual({
      liked: true,
      saved: true,
    });
    await session.rpc.shorts.react({ videoId: VIDEO, kind: "save", on: true });
    expect((await session.rpc.shorts.saved({ kind: "save" })).map((s) => s.videoId)).toEqual([
      VIDEO,
    ]);
    await expect(
      session.rpc.shorts.react({ videoId: VIDEO, kind: "like", on: false }),
    ).resolves.toEqual({
      liked: false,
      saved: true,
    });
    expect(await session.rpc.shorts.saved({ kind: "like" })).toEqual([]);

    const other = await signedIn();
    expect(await other.session.rpc.shorts.saved({ kind: "save" })).toEqual([]);
  });
});

describe("Director", () => {
  it("asks the AI service for a plan once the short is one, as the member in their workspace", async () => {
    const { session, me } = await signedIn();
    await expectError(session.rpc.director.plan({ videoId: VIDEO }), "DIRECTOR_PLAN_NOT_FOUND");
    const plan = await session.rpc.director.requestPlan({ videoId: VIDEO });
    expect(plan).toMatchObject({
      videoId: VIDEO,
      status: "pending",
      plan: null,
      createdAt: expect.any(Date),
    });
    expect(aiCalls.at(-1)).toMatchObject({
      route: "POST /v1/director/plans",
      org: me.activeOrganizationId,
      user: me.id,
      body: { videoId: VIDEO },
    });
    await expect(session.rpc.director.plan({ videoId: VIDEO })).resolves.toMatchObject({
      id: plan.id,
    });
  });

  it("refuses shorts that are too long or aren't there, before the AI service hears of them", async () => {
    const { session } = await signedIn();
    const before = aiCalls.length;
    await expectError(session.rpc.director.requestPlan({ videoId: LONG }), "SHORT_TOO_LONG");
    await expectError(session.rpc.director.requestPlan({ videoId: GONE }), "SHORT_NOT_FOUND");
    expect(aiCalls.length).toBe(before);
  });

  it("passes on the scene check, and parses what comes back", async () => {
    const { session } = await signedIn();
    const image = "/9j/".padEnd(200, "A");
    await expect(
      session.rpc.director.checkScene({ videoId: VIDEO, shotIndex: 0, image }),
    ).resolves.toMatchObject({
      direction: "left",
      landmark: { label: "tree" },
    });
    await expectError(
      session.rpc.director.checkScene({ videoId: VIDEO, shotIndex: 0, image: "short" }),
      "VALIDATION_FAILED",
    );
  });

  it("adds a take from the member's own ready upload, handing the AI service a read of it", async () => {
    const { session, me } = await signedIn();
    await session.rpc.director.requestPlan({ videoId: VIDEO });
    const { file } = await session.rpc.files.createUpload({
      purpose: "director-take-video",
      filename: "shot-1.webm",
      contentType: "video/webm",
      size: 1000,
    });
    // Not checked yet: no take.
    await expectError(
      session.rpc.director.addTake({
        videoId: VIDEO,
        shotIndex: 0,
        kind: "video",
        fileId: file.id,
      }),
      "FILE_NOT_READY",
    );
    // What apps/worker does once it has checked the upload.
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'video/webm', size = 1000, ready_at = now() WHERE id = $1",
      [file.id],
    );
    // The wrong kind for the file's purpose is no file at all.
    await expectError(
      session.rpc.director.addTake({
        videoId: VIDEO,
        shotIndex: 0,
        kind: "photo",
        fileId: file.id,
      }),
      "FILE_NOT_FOUND",
    );
    const take = await session.rpc.director.addTake({
      videoId: VIDEO,
      shotIndex: 0,
      kind: "video",
      fileId: file.id,
    });
    expect(take).toMatchObject({ fileId: file.id, status: "pending", createdAt: expect.any(Date) });
    const sent = aiCalls.at(-1);
    expect(sent).toMatchObject({
      route: "POST /v1/director/takes",
      user: me.id,
      body: { contentType: "video/webm" },
    });
    const source = new URL(lastSourceUrl);
    expect(source.pathname).toContain(`files/${file.id}`);
    expect(source.searchParams.get("X-Amz-Expires")).toBe("1800");

    expect((await session.rpc.director.takes({ videoId: VIDEO })).map((t) => t.id)).toEqual([
      take.id,
    ]);
    // Someone else's file is never theirs to use.
    const other = await signedIn();
    await expectError(
      other.session.rpc.director.addTake({
        videoId: VIDEO,
        shotIndex: 0,
        kind: "video",
        fileId: file.id,
      }),
      "FILE_NOT_FOUND",
    );
    await expect(other.session.rpc.director.takes({ videoId: VIDEO })).resolves.toEqual([]);
  });

  it("gives a short-lived URL to the member's own ready file, and nobody else's", async () => {
    const { session } = await signedIn();
    const { file } = await session.rpc.files.createUpload({
      purpose: "director-take-photo",
      filename: "shot-2.jpg",
      contentType: "image/jpeg",
      size: 500,
    });
    await expectError(session.rpc.files.downloadUrl({ fileId: file.id }), "FILE_NOT_FOUND");
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'image/jpeg', size = 500, ready_at = now() WHERE id = $1",
      [file.id],
    );
    const { url, expiresAt } = await session.rpc.files.downloadUrl({ fileId: file.id });
    expect(new URL(url).pathname).toContain(`files/${file.id}`);
    expect(expiresAt).toBeInstanceOf(Date);
    const other = await signedIn();
    await expectError(other.session.rpc.files.downloadUrl({ fileId: file.id }), "FILE_NOT_FOUND");
  });
});
