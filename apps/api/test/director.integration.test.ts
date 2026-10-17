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
import { WebSocket } from "ws";
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
/** A plan the AI service fails to read. */
const BROKEN = "BrokenPlan1";

let harness: Harness;
let youtube: Server;
let ai: Server;
const youtubeCalls: URL[] = [];
const aiCalls: { route: string; org: string; user: string; body: unknown }[] = [];
/** The presigned read the AI service was last handed for a take. */
let lastSourceUrl = "";
/** What YouTube does next: answer, run out of quota, have comments off, or answer garbage. */
let youtubeMode: "ok" | "quota" | "comments-off" | "garbled" = "ok";

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
  if (youtubeMode === "garbled") {
    return send(response, 200, { items: "not a list" });
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
  /** Who indexed it: the AI service holds each member to one (DIRECTOR_INDEX_LIMIT). */
  user: string | null;
  videoId: string;
  status: string;
  audioKey: string | null;
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
  score: number | null;
  createdAt: string;
}[] = [];
const cuts: {
  id: string;
  org: string;
  user: string;
  plan: StandInPlan;
  body: unknown;
  createdAt: string;
}[] = [];

function planOut(plan: StandInPlan) {
  const now = new Date().toISOString();
  return {
    id: plan.id,
    videoId: plan.videoId,
    source: plan.user ? "user" : "seed",
    status: plan.status,
    stage: plan.status === "ready" ? "ready" : "queued",
    error: null,
    plan: plan.status === "ready" ? PLAN : null,
    model: plan.status === "ready" ? "gemini-test" : null,
    audioStatus: plan.audioKey ? "ready" : "none",
    audioKey: plan.audioKey,
    createdAt: now,
    updatedAt: now,
  };
}

/** A plan of the workspace's, ready to film, as a seeded template is. */
function readyTemplate(org: string, videoId: string, audioKey: string | null = null) {
  const plan = { id: randomUUID(), org, user: null, videoId, status: "ready", audioKey };
  plans.unshift(plan);
  return plan;
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
  const answer = libraryRoute(route, who, body) ?? directorCutRoute(route, who, body);
  if (answer) {
    return send(response, answer.status, answer.body);
  }
  const planMatch = /^GET \/v1\/director\/plans\/([\w-]{11})$/.exec(route);
  if (planMatch?.[1] === BROKEN) {
    return send(response, 500, {});
  }
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
      score: null,
      createdAt: new Date().toISOString(),
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
    status: take.score === null ? "pending" : "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: take.score,
    feedback: null,
    createdAt: take.createdAt,
  };
}

function cutOut(cut: (typeof cuts)[number]) {
  const body = cut.body as { title: string; fileId: string; picks: unknown[] };
  return {
    id: cut.id,
    planId: cut.plan.id,
    videoId: cut.plan.videoId,
    templateTitle: PLAN.title,
    title: body.title,
    picks: body.picks,
    fileId: body.fileId,
    durationMs: 9000,
    publishStatus: "none",
    youtubeVideoId: null,
    visibility: null,
    createdAt: cut.createdAt,
  };
}

function failure(status: number, code: string) {
  return { status, body: { defined: true, code, status, message: code, data: { params: {} } } };
}

/** The AI service's library: a workspace's plans, and each member's one short of their own. */
function libraryRoute(
  route: string,
  who: { org: string; user: string },
  body: Record<string, unknown>,
): { status: number; body: unknown } | null {
  const own = plans.filter((p) => p.org === who.org);
  if (route === "GET /v1/director/library") {
    const indexUsed = own.some((p) => p.user === who.user);
    return { status: 200, body: { templates: own.map(planOut), indexUsed } };
  }
  if (route !== "POST /v1/director/plans") {
    return null;
  }
  const videoId = String(body.videoId);
  const found = own.find((p) => p.videoId === videoId);
  if (found) {
    return { status: 200, body: planOut(found) };
  }
  if (plans.some((p) => p.user === who.user)) {
    return failure(409, "DIRECTOR_INDEX_LIMIT");
  }
  const plan = { id: randomUUID(), org: who.org, user: who.user, videoId, status: "pending" };
  plans.unshift({ ...plan, audioKey: null });
  return { status: 200, body: planOut({ ...plan, audioKey: null }) };
}

/** The AI service's routes for cuts: each member's own, of their workspace's plans. */
function directorCutRoute(
  route: string,
  who: { org: string; user: string },
  body: Record<string, unknown>,
): { status: number; body: unknown } | null {
  const mine = cuts.filter((c) => c.org === who.org && c.user === who.user);
  if (route === "POST /v1/director/cuts") {
    const plan = plans.find((p) => p.org === who.org && p.videoId === body.videoId);
    if (!plan) {
      return failure(404, "DIRECTOR_PLAN_NOT_FOUND");
    }
    const createdAt = new Date().toISOString();
    const cut = { id: randomUUID(), org: who.org, user: who.user, plan, body, createdAt };
    cuts.unshift(cut);
    return { status: 201, body: cutOut(cut) };
  }
  if (route === "GET /v1/director/cuts") {
    return { status: 200, body: mine.map(cutOut) };
  }
  const ofPlan = /^GET \/v1\/director\/plans\/([\w-]{11})\/cuts$/.exec(route);
  if (ofPlan) {
    return { status: 200, body: mine.filter((c) => c.plan.videoId === ofPlan[1]).map(cutOut) };
  }
  return null;
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
    // The live call is on; no test here gets as far as calling Google.
    GOOGLE_CLOUD_PROJECT: "director-test",
    GOOGLE_ACCESS_TOKEN: "test-token",
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
  return error as ORPCError<string, unknown>;
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

  it("fails as a bug, not as YouTube being down, when YouTube's answer isn't its format", async () => {
    const { session } = await signedIn();
    youtubeMode = "garbled";
    await expectError(session.rpc.shorts.feed({ topic: "dance" }), "INTERNAL");
  });

  it("orders the topic of everything by views, and the trends by relevance", async () => {
    const { session } = await signedIn();
    await session.rpc.shorts.feed({ topic: "all" });
    expect(
      youtubeCalls.findLast((url) => url.pathname === "/search")?.searchParams.get("order"),
    ).toBe("viewCount");
    await session.rpc.shorts.feed({ topic: "pets" });
    expect(
      youtubeCalls.findLast((url) => url.pathname === "/search")?.searchParams.get("order"),
    ).toBe("relevance");
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

describe("Director's library", () => {
  it("indexes a short from any kind of link, as the member in their workspace", async () => {
    const { session, me } = await signedIn();
    await expectError(session.rpc.director.plan({ videoId: VIDEO }), "DIRECTOR_PLAN_NOT_FOUND");
    const plan = await session.rpc.director.index({ url: `https://youtu.be/${VIDEO}` });
    expect(plan).toMatchObject({
      videoId: VIDEO,
      source: "user",
      status: "pending",
      stage: "queued",
      plan: null,
      audio: { status: "none", url: null },
      createdAt: expect.any(Date),
    });
    expect(aiCalls.at(-1)).toMatchObject({
      route: "POST /v1/director/plans",
      org: me.activeOrganizationId,
      user: me.id,
      body: { videoId: VIDEO },
    });
    for (const url of [`https://www.youtube.com/shorts/${VIDEO}`, `youtube.com/watch?v=${VIDEO}`]) {
      await expect(session.rpc.director.index({ url })).resolves.toMatchObject({ id: plan.id });
    }
    await expect(session.rpc.director.plan({ videoId: VIDEO })).resolves.toMatchObject({
      id: plan.id,
    });
    await expect(session.rpc.director.library()).resolves.toEqual({
      templates: [expect.objectContaining({ id: plan.id })],
      indexUsed: true,
    });
  });

  it("refuses links that aren't a short Director can film, before the AI service hears of them", async () => {
    const { session } = await signedIn();
    const before = aiCalls.length;
    const tooLong = await expectError(
      session.rpc.director.index({ url: `https://www.youtube.com/watch?v=${LONG}` }),
      "DIRECTOR_TOO_LONG",
    );
    expect(tooLong.data).toMatchObject({ params: { maxSeconds: 180 } });
    for (const url of [`https://youtu.be/${GONE}`, "https://example.com/watch?v=x"]) {
      await expectError(session.rpc.director.index({ url }), "DIRECTOR_VIDEO_UNAVAILABLE");
    }
    expect(aiCalls.length).toBe(before);
  });

  it("passes on a second short of the member's own as DIRECTOR_INDEX_LIMIT", async () => {
    const { session } = await signedIn();
    await session.rpc.director.index({ url: VIDEO });
    await expectError(session.rpc.director.index({ url: "Short2xxxxx" }), "DIRECTOR_INDEX_LIMIT");
  });

  it("lists the workspace's templates, with a short-lived link to each one's audio", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    const silent = readyTemplate(org, "SeedSilent1");
    const sung = readyTemplate(org, "SeedSinger1", "seed-audio/SeedSinger1.m4a");
    const { templates, indexUsed } = await session.rpc.director.library();
    expect(indexUsed).toBe(false);
    expect(templates.map((plan) => [plan.id, plan.source, plan.audio.status])).toEqual([
      [sung.id, "seed", "ready"],
      [silent.id, "seed", "none"],
    ]);
    expect(templates[1]?.audio.url).toBeNull();
    const audio = new URL(String(templates[0]?.audio.url));
    expect(audio.pathname).toContain("seed-audio/SeedSinger1.m4a");
    expect(audio.searchParams.get("X-Amz-Expires")).toBe("3600");
    // Another workspace has none of them.
    const other = await signedIn();
    await expect(other.session.rpc.director.library()).resolves.toEqual({
      templates: [],
      indexUsed: false,
    });
  });
});

describe("Director", () => {
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
    await session.rpc.director.index({ url: VIDEO });
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

  it("refuses a take whose file was stored as a type no take is, before the AI service hears of it", async () => {
    const { session } = await signedIn();
    const { file } = await session.rpc.files.createUpload({
      purpose: "director-take-photo",
      filename: "shot-3.png",
      contentType: "image/png",
      size: 500,
    });
    // The worker stores a photo as JPEG; a ready one that isn't is no take's file.
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'image/png', size = 500, ready_at = now() WHERE id = $1",
      [file.id],
    );
    const before = aiCalls.length;
    await expectError(
      session.rpc.director.addTake({
        videoId: VIDEO,
        shotIndex: 0,
        kind: "photo",
        fileId: file.id,
      }),
      "FILE_NOT_FOUND",
    );
    expect(aiCalls.length).toBe(before);
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

describe("Director's shots and cuts", () => {
  /** A take of the member's in the AI service, scored as its review would. */
  function scoredTake(org: string, user: string, score: number | null, at: string) {
    const take = {
      id: randomUUID(),
      org,
      user,
      videoId: "ShotsShort1",
      shotIndex: 0,
      fileId: randomUUID(),
      kind: "video",
      score,
      createdAt: at,
    };
    takes.push(take);
    return take;
  }

  it("picks each shot's best take, the newest of a tie, and flags a retake below 60", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    const plan = readyTemplate(org, "ShotsShort1");
    const low = scoredTake(org, me.id, 45, "2026-10-18T10:00:00Z");
    const tied = scoredTake(org, me.id, 59, "2026-10-18T10:01:00Z");
    const newest = scoredTake(org, me.id, 59, "2026-10-18T10:02:00Z");
    const [shot] = await session.rpc.director.shots({ videoId: "ShotsShort1" });
    expect(shot).toMatchObject({ index: 0, pickedTakeId: newest.id, needsRetake: true });
    expect(shot?.takes.map((take) => take.id)).toEqual([newest.id, tied.id, low.id]);
    const good = scoredTake(org, me.id, 60, "2026-10-18T09:00:00Z");
    await expect(session.rpc.director.shots({ videoId: "ShotsShort1" })).resolves.toMatchObject([
      { pickedTakeId: good.id, needsRetake: false },
    ]);
    // Before the plan is ready there are no shots to show.
    plan.status = "analyzing";
    await expectError(
      session.rpc.director.shots({ videoId: "ShotsShort1" }),
      "DIRECTOR_PLAN_NOT_READY",
    );
  });

  async function readyUpload(session: Awaited<ReturnType<typeof signedIn>>["session"]) {
    const { file } = await session.rpc.files.createUpload({
      purpose: "director-cut-video",
      filename: "my-cut.mp4",
      contentType: "video/mp4",
      size: 5000,
    });
    return file;
  }

  async function markReady(fileId: string) {
    // What apps/worker does once it has checked the upload.
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'video/mp4', size = 5000, ready_at = now() WHERE id = $1",
      [fileId],
    );
  }

  it("saves a cut from the member's own ready upload, and lists it", async () => {
    const { session, me } = await signedIn();
    readyTemplate(String(me.activeOrganizationId), "CutsShort01");
    const take = randomUUID();
    const file = await readyUpload(session);
    const input = { videoId: "CutsShort01", picks: { 0: take }, fileId: file.id, title: "Mine" };
    // Not checked yet: no cut.
    await expectError(session.rpc.director.saveCut(input), "FILE_NOT_READY");
    await markReady(file.id);
    const cut = await session.rpc.director.saveCut(input);
    expect(cut).toEqual({
      id: expect.any(String),
      planId: expect.any(String),
      videoId: "CutsShort01",
      templateTitle: "Pen drop",
      title: "Mine",
      picks: { 0: take },
      fileId: file.id,
      durationMs: 9000,
      createdAt: expect.any(Date),
      publish: { status: "none", youtubeVideoId: null, visibility: null },
    });
    expect(aiCalls.at(-1)).toMatchObject({
      route: "POST /v1/director/cuts",
      user: me.id,
      body: { picks: [{ shotIndex: 0, takeId: take }], fileId: file.id, title: "Mine" },
    });
    await expect(session.rpc.director.cuts({ videoId: "CutsShort01" })).resolves.toEqual([cut]);
    await expect(session.rpc.director.media()).resolves.toEqual([cut]);
  });

  it("refuses a cut of someone else's file, or of a file that isn't a cut", async () => {
    const { session, me } = await signedIn();
    readyTemplate(String(me.activeOrganizationId), "CutsShort02");
    const file = await readyUpload(session);
    await markReady(file.id);
    const input = {
      videoId: "CutsShort02",
      picks: { 0: randomUUID() },
      fileId: file.id,
      title: "Theirs",
    };
    const before = aiCalls.length;
    const other = await signedIn();
    await expectError(other.session.rpc.director.saveCut(input), "FILE_NOT_FOUND");
    const { file: take } = await session.rpc.files.createUpload({
      purpose: "director-take-video",
      filename: "take.webm",
      contentType: "video/webm",
      size: 1000,
    });
    await expectError(
      session.rpc.director.saveCut({ ...input, fileId: take.id }),
      "FILE_NOT_FOUND",
    );
    // Nothing picked, or a title too long for YouTube, isn't a cut either.
    await expectError(session.rpc.director.saveCut({ ...input, picks: {} }), "VALIDATION_FAILED");
    await expectError(
      session.rpc.director.saveCut({ ...input, title: "x".repeat(101) }),
      "VALIDATION_FAILED",
    );
    expect(aiCalls.length).toBe(before);
  });
});

// The call itself (the relay to Gemini) is unit-tested against a stand-in for the Live
// API (src/modules/live/live.test.ts); this is who may start one, through the real server.
describe("Director's live call", () => {
  /** Opens /api/live as the session's browser would, and reads what it says before closing. */
  async function call(cookies: Map<string, string>, videoId: string) {
    const socket = new WebSocket(
      `${harness.baseUrl.replace(/^http/, "ws")}/api/live?videoId=${videoId}&shot=0`,
      {
        headers: {
          origin: process.env.WEB_URL ?? "http://localhost:3000",
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
      },
    );
    const received: unknown[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    const code = await new Promise<number>((resolve) => socket.on("close", resolve));
    return { code, received };
  }

  it("refuses a browser that isn't signed in", async () => {
    expect(await call(new Map(), VIDEO)).toEqual({
      code: 1008,
      received: [{ type: "error", code: "UNAUTHENTICATED" }],
    });
  });

  it("asks for the member's plan in their workspace, and waits until it's ready", async () => {
    const { session, me } = await signedIn();
    expect(await call(session.cookies(), "LiveVideo01")).toEqual({
      code: 1008,
      received: [{ type: "error", code: "DIRECTOR_PLAN_NOT_FOUND" }],
    });
    expect(aiCalls.at(-1)).toMatchObject({
      route: "GET /v1/director/plans/LiveVideo01",
      user: me.id,
    });
    await session.rpc.director.index({ url: VIDEO });
    expect(await call(session.cookies(), VIDEO)).toEqual({
      code: 1008,
      received: [{ type: "error", code: "DIRECTOR_PLAN_NOT_FOUND" }],
    });
  });

  it("says the AI service failed when the plan can't be read", async () => {
    const { session } = await signedIn();
    expect(await call(session.cookies(), BROKEN)).toEqual({
      code: 1011,
      received: [{ type: "error", code: "UPSTREAM_UNAVAILABLE" }],
    });
  });
});
