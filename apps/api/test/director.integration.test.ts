/**
 * Director through the API, against strict stand-ins for YouTube's
 * Data API and for the Python AI service (which checks the per-call token the API signs).
 * The real AI service is covered by its own tests (apps/ai/tests/test_director.py).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { directorTakeIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { CHAT_USAGE, startFakeGoogle } from "@repo/fake-google";
import { TAKE_REVIEW_READ_S } from "@repo/jobs";
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
/** A committed seed, with its plan and media. */
const SEED = required(directorSeeds[0], "a committed seed");
/** A take the AI service says isn't the member's take of the shot. */
const SOMEONE_ELSES_TAKE = randomUUID();
/** A plan the AI service fails to read. */
const BROKEN = "BrokenPlan1";
/** A line the AI service has no budget left to say. */
const OVER_BUDGET = "Over budget.";
/** What the AI service says a line as: a WAV file's header, then the line and voice. */
const spoken = (text: string, voice: string) =>
  Buffer.concat([
    Buffer.from("RIFF\x00\x00\x00\x00WAVE", "latin1"),
    Buffer.from(`${voice}:${text}`),
  ]);

let harness: Harness;
let youtube: Server;
let ai: Server;
/** Vertex AI's generateContent, where the slower line asks Gemini. */
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
/** Workspaces whose AI allowance the AI service says is spent. */
const spentOrgs = new Set<string>();
/** Workspaces whose turns the AI service's ledger fails to settle. */
const unsettledOrgs = new Set<string>();
const youtubeCalls: URL[] = [];
const aiCalls: { route: string; org: string; user: string; body: unknown }[] = [];
/** The presigned read the AI service was last handed for a take. */
let lastSourceUrl = "";
/** What YouTube does next: answer, run out of quota, or answer garbage. */
let youtubeMode: "ok" | "quota" | "garbled" = "ok";

function video(id: string, duration: string) {
  return { id, contentDetails: { duration } };
}

const VIDEOS: Partial<Record<string, ReturnType<typeof video>>> = {
  [VIDEO]: video(VIDEO, "PT45S"),
  [LONG]: video(LONG, "PT4M2S"),
  Short2xxxxx: video("Short2xxxxx", "PT12S"),
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
  if (url.pathname === "/videos") {
    const ids = (url.searchParams.get("id") ?? "").split(",");
    return send(response, 200, { items: ids.flatMap((id) => VIDEOS[id] ?? []) });
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

/** Another workspace's object: what a stored plan must never get anyone a link to. */
const FOREIGN_KEY = `files/${randomUUID()}/take.webm`;

/** `plan` with storage keys planted in it, as a tampered or stale row might hold. */
function withForeignKeys(plan: { shots: object[] }) {
  return {
    ...plan,
    musicKey: FOREIGN_KEY,
    shots: plan.shots.map((shot) => ({
      ...shot,
      storyboardKey: FOREIGN_KEY,
      previewKey: FOREIGN_KEY,
    })),
  };
}

interface StandInPlan {
  id: string;
  org: string;
  /** Who indexed it: the AI service holds each member to one (DIRECTOR_INDEX_LIMIT). */
  user: string | null;
  videoId: string;
  status: string;
  audioKey: string | null;
  /** The plan the AI service answers with, once ready (PLAN unless a test says). */
  plan?: unknown;
  /** The default images of its assets, as the AI service reports them. */
  assetImages?: unknown[];
  /** A created plan's storyboard cards, as the AI service reports them. */
  storyboards?: unknown[];
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
  chosen?: boolean;
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
  const written = plan.plan ?? PLAN;
  return {
    id: plan.id,
    videoId: plan.videoId,
    source: plan.user ? "user" : "seed",
    status: plan.status,
    stage: plan.status === "ready" ? "ready" : "queued",
    error: null,
    plan: plan.status === "ready" ? written : null,
    model: plan.status === "ready" ? "gemini-test" : null,
    audioStatus: plan.audioKey ? "ready" : "none",
    audioKey: plan.audioKey,
    // Left out unless a test sets them, as an AI service from before them answers.
    ...(plan.assetImages && { assetImages: plan.assetImages }),
    ...(plan.storyboards && { storyboards: plan.storyboards }),
    createdAt: now,
    updatedAt: now,
  };
}

/** A plan of the workspace's, ready to film, as a seeded template is. */
function readyTemplate(
  org: string,
  videoId: string,
  audioKey: string | null = null,
  extra: Partial<StandInPlan> = {},
) {
  const plan = { id: randomUUID(), org, user: null, videoId, status: "ready", audioKey, ...extra };
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

/** The member's choice of take for a shot, as apps/ai keeps it: one a shot. */
function choicesRoute(
  route: string,
  who: { org: string; user: string },
  body: Record<string, unknown>,
) {
  const match = /^POST \/v1\/director\/plans\/([\w-]{11})\/choices$/.exec(route);
  if (!match) {
    return null;
  }
  const mine = takes.filter(
    (t) =>
      t.org === who.org &&
      t.user === who.user &&
      t.videoId === match[1] &&
      t.shotIndex === body.shotIndex,
  );
  if (body.takeId !== null && !mine.some((t) => t.id === body.takeId)) {
    return failure(404, "DIRECTOR_TAKE_NOT_FOUND");
  }
  for (const take of mine) {
    take.chosen = take.id === body.takeId;
  }
  return { status: 204, body: undefined };
}

/** A match cut the AI service lines up: a plain cut, whatever it's sent. */
function matchCutRoute(route: string) {
  return route === "POST /v1/director/match-cuts"
    ? {
        status: 200,
        body: {
          status: "not-found",
          outgoingEndMs: 1500,
          incomingStartMs: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          offsetBeforePx: 0,
          offsetPx: 0,
          scaleDiff: 0,
          rotationDiff: 0,
          cropPercent: 0,
          withinTolerance: false,
          anchor: null,
          outgoingFrame: null,
          incomingFrame: null,
        },
      }
    : null;
}

/** The AI ledger's turns of the slower line: refused once the workspace's month is spent. */
function chatLedgerRoute(route: string, who: { org: string }) {
  if (route === "POST /v1/director/chat-reservations") {
    return spentOrgs.has(who.org)
      ? failure(429, "AI_BUDGET_EXCEEDED")
      : { status: 201, body: { tokens: 20_000 } };
  }
  if (route !== "POST /v1/director/chat-usage") {
    return null;
  }
  return unsettledOrgs.has(who.org) ? failure(500, "INTERNAL") : { status: 204, body: undefined };
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
  const answer =
    libraryRoute(route, who, body) ??
    directorCutRoute(route, who, body) ??
    choicesRoute(route, who, body) ??
    chatLedgerRoute(route, who) ??
    matchCutRoute(route);
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
  if (route === "POST /v1/director/speak") {
    if (body.text === OVER_BUDGET) {
      return fail(429, "AI_BUDGET_EXCEEDED");
    }
    response.writeHead(200, { "content-type": "audio/wav" });
    return response.end(spoken(String(body.text), String(body.voice)));
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
    reason: take.score === null ? null : "The cleanest delivery.",
    chosen: take.chosen ?? false,
    origin: "shoot",
    createdAt: take.createdAt,
  };
}

function cutOut(cut: (typeof cuts)[number]) {
  const body = cut.body as {
    title: string;
    fileId: string;
    picks: unknown[];
    durationMs?: number;
  };
  return {
    id: cut.id,
    planId: cut.plan.id,
    videoId: cut.plan.videoId,
    templateTitle: PLAN.title,
    title: body.title,
    picks: body.picks,
    fileId: body.fileId,
    // As the AI service records it: the editor's figure, else the picks added up.
    durationMs: body.durationMs ?? 9000,
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
    if (JSON.stringify(body.picks).includes(SOMEONE_ELSES_TAKE)) {
      return failure(404, "DIRECTOR_TAKE_NOT_FOUND");
    }
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
  google = await startFakeGoogle({ apiKey: "unused", liveToken: "test-token" });
  harness = await startApi(24, {
    ...LOCAL_STORAGE,
    YOUTUBE_API_KEY: KEY,
    YOUTUBE_API_URL: await listen(youtube),
    AI_URL: await listen(ai),
    AI_SERVICE_SECRET: SECRET,
    // The live call is on; only the slower line gets as far as calling Google.
    GOOGLE_CLOUD_PROJECT: "director-test",
    GOOGLE_ACCESS_TOKEN: "test-token",
    CHAT_API_URL: google.url,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => youtube?.close(resolve));
  await new Promise((resolve) => ai?.close(resolve));
  await google?.close();
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

describe("checking a link on YouTube", () => {
  it("is on with YouTube and the AI service configured", async () => {
    const { session } = await signedIn();
    expect((await session.rpc.system.info()).features.director).toBe(true);
  });

  it("asks YouTube once an hour per short, from the cache in between", async () => {
    const { session } = await signedIn();
    await session.rpc.director.index({ url: VIDEO });
    const asked = youtubeCalls.filter((url) => url.pathname === "/videos").length;
    await session.rpc.director.index({ url: `https://youtu.be/${VIDEO}` });
    expect(youtubeCalls.filter((url) => url.pathname === "/videos").length).toBe(asked);
    expect(youtubeCalls.at(-1)?.searchParams.get("id")).toBe(VIDEO);
  });

  it("turns YouTube's refusals into UPSTREAM_UNAVAILABLE", async () => {
    const { session } = await signedIn();
    youtubeMode = "quota";
    await expectError(session.rpc.director.index({ url: VIDEO }), "UPSTREAM_UNAVAILABLE");
  });

  it("fails as a bug, not as YouTube being down, when YouTube's answer isn't its format", async () => {
    const { session } = await signedIn();
    youtubeMode = "garbled";
    await expectError(session.rpc.director.index({ url: VIDEO }), "INTERNAL");
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

  it("refuses links that aren't a short Director can film, before the AI service indexes them", async () => {
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
    // Only asked whether the library has them (to open one that is): never to index them.
    expect(aiCalls.slice(before).map((call) => call.route)).toEqual([
      `GET /v1/director/plans/${LONG}`,
      `GET /v1/director/plans/${GONE}`,
    ]);
  });

  it("opens a short already in the library as often as asked, and limits only new links", async () => {
    const { session, me } = await signedIn();
    const template = readyTemplate(String(me.activeOrganizationId), "Short2xxxxx");
    const asked = youtubeCalls.length;
    for (let i = 0; i < 12; i++) {
      await expect(
        session.rpc.director.index({ url: `https://www.youtube.com/shorts/Short2xxxxx` }),
      ).resolves.toMatchObject({ id: template.id });
    }
    // Opening one asks YouTube nothing either.
    expect(youtubeCalls.length).toBe(asked);
    // Links that aren't in the library cost a lookup each: ten an hour.
    for (let i = 0; i < 10; i++) {
      await expectError(
        session.rpc.director.index({ url: `https://youtu.be/${GONE}` }),
        "DIRECTOR_VIDEO_UNAVAILABLE",
      );
    }
    await expectError(
      session.rpc.director.index({ url: `https://youtu.be/${GONE}` }),
      "RATE_LIMITED",
    );
    // Still free to open what's there.
    await expect(session.rpc.director.index({ url: "Short2xxxxx" })).resolves.toMatchObject({
      id: template.id,
    });
  });

  it("indexes again a short whose plan failed, and passes on a library it can't read", async () => {
    const { session, me } = await signedIn();
    readyTemplate(String(me.activeOrganizationId), VIDEO, null, { status: "failed" });
    const before = aiCalls.length;
    await session.rpc.director.index({ url: VIDEO });
    expect(aiCalls.slice(before).map((call) => call.route)).toEqual([
      `GET /v1/director/plans/${VIDEO}`,
      "POST /v1/director/plans",
    ]);
    await expectError(session.rpc.director.index({ url: BROKEN }), "UPSTREAM_UNAVAILABLE");
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

  it("links a seeded template's media on its own page, from the committed seed only", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    // A seed's copy, made before the seeds had media (or tampered with): the keys planted
    // in its stored plan are never signed; the committed seed's are.
    readyTemplate(org, SEED.videoId, null, { plan: withForeignKeys(SEED.plan) });
    const one = await session.rpc.director.plan({ videoId: SEED.videoId });
    const media = required(SEED.media, "the committed seed's media");
    const signed = (url: string | undefined, key: string | undefined) => {
      const link = new URL(String(url));
      expect(link.pathname).toContain(required(key, "a key"));
      expect(link.searchParams.get("X-Amz-Expires")).toBe("3600");
    };
    signed(one.plan?.musicUrl, media.music);
    for (const [index, shot] of media.shots.entries()) {
      signed(one.plan?.shots[index]?.storyboardUrl, shot.storyboard);
      signed(one.plan?.shots[index]?.previewUrl, shot.preview);
    }
    expect(JSON.stringify(one)).not.toContain("files/");
    expect(JSON.stringify(one)).not.toMatch(/"(music|storyboard|preview)Key"/);

    // The library lists it without its media: that's dozens of signatures per read, for
    // cards no list shows.
    const { templates } = await session.rpc.director.library();
    expect(JSON.stringify(templates)).not.toMatch(/Url"|files\//);
  });

  it("links a plan's asset images on its own page, only from the plan's own folder", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    const asset = (id: string) => ({
      id,
      kind: "image",
      title: "The chart",
      role: "Under the speaker, in a split screen",
      description: "A chart of twelve archetypes.",
      prompt: 'A flat black-and-white chart titled "12 ARCHETYPES".',
      sourceStartSeconds: 0,
      sourceEndSeconds: 9,
      defaultSource: "create",
      personalisable: true,
      ask: null,
      secondScreen: false,
      reference: {
        subject: "Twelve archetypes, a portrait on each row",
        composition: "Title on top, twelve rows below",
        style: "Flat infographic",
        palette: "Black and white",
        blackAndWhite: true,
        aspectRatio: "9:8",
        text: ["12 ARCHETYPES"],
        mood: "Bold",
      },
    });
    const plan = readyTemplate(org, "AssetShort1", null, {
      user: me.id,
      plan: { ...PLAN, assets: [asset("chart"), asset("card"), asset("end-card")] },
    });
    plan.assetImages = [
      { assetId: "chart", status: "ready", objectKey: `director-assets/${plan.id}/chart.png` },
      // A key that isn't this image's own is never signed.
      { assetId: "card", status: "ready", objectKey: FOREIGN_KEY },
      { assetId: "end-card", status: "generating", objectKey: null },
      // An image of an asset the plan no longer has is neither signed nor served.
      { assetId: "gone", status: "ready", objectKey: `director-assets/${plan.id}/gone.png` },
    ];
    const one = await session.rpc.director.plan({ videoId: "AssetShort1" });
    const [chart, card, endCard] = one.plan?.assets ?? [];
    const link = new URL(String(chart?.image?.url));
    expect(link.pathname).toContain(`director-assets/${plan.id}/chart.png`);
    expect(link.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(card?.image).toEqual({ status: "failed", url: null });
    expect(endCard?.image).toEqual({ status: "making", url: null });
    expect(JSON.stringify(one)).not.toMatch(/files\/|objectKey/);
    expect(JSON.stringify(one)).not.toContain("gone.png");
    // The library lists the plan with its assets, but leaves their images to its page.
    const { templates } = await session.rpc.director.library();
    const listed = templates.find((each) => each.id === plan.id);
    expect(listed?.plan?.assets.map((each) => each.id)).toEqual(["chart", "card", "end-card"]);
    expect(listed?.plan?.assets.some((each) => "image" in each)).toBe(false);
  });

  it("links a plan's storyboard cards only where its own may be stored", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    const plan = readyTemplate(org, "Storyboard1", null, {
      user: me.id,
      plan: { ...PLAN, shots: [PLAN.shots[0], PLAN.shots[0]] },
    });
    plan.storyboards = [
      {
        shotIndex: 0,
        status: "ready",
        objectKey: `director-assets/${plan.id}/shot-0123456789abcdef.png`,
      },
      // A key the AI service answered that isn't a card of this plan's: never signed.
      { shotIndex: 1, status: "ready", objectKey: FOREIGN_KEY },
    ];
    const one = await session.rpc.director.plan({ videoId: "Storyboard1" });
    const [first, second] = one.plan?.shots ?? [];
    expect(new URL(String(first?.storyboardUrl)).pathname).toContain(
      `director-assets/${plan.id}/shot-0123456789abcdef.png`,
    );
    expect(second).not.toHaveProperty("storyboardUrl");
    expect(JSON.stringify(one)).not.toContain("files/");
  });

  it("links a created plan's drawn cards and says what became of the others", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    const plan = readyTemplate(org, "CreatedOne1", null, {
      user: me.id,
      plan: { ...PLAN, shots: [...PLAN.shots, ...PLAN.shots] },
    });
    plan.storyboards = [
      {
        shotIndex: 0,
        status: "ready",
        objectKey: `director-assets/${plan.id}/shot-0123456789abcdef.png`,
      },
      { shotIndex: 1, status: "failed", objectKey: null, error: "AI_BUDGET_EXCEEDED" },
    ];
    const served = await session.rpc.director.plan({ videoId: "CreatedOne1" });
    const [drawn, broke] = served.plan?.shots ?? [];
    expect(new URL(String(drawn?.storyboardUrl)).pathname).toContain("shot-0123456789abcdef.png");
    expect(drawn?.storyboardState).toBeUndefined();
    expect(broke?.storyboardUrl).toBeUndefined();
    expect(broke?.storyboardState).toBe("noAllowance");
  });

  it("links no media for any other plan, whatever its stored plan names", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    // Not a committed seed: nothing to link, and the planted keys aren't signed.
    readyTemplate(org, "NotASeed001", null, { plan: withForeignKeys(PLAN) });
    // A committed seed's Short with another number of shots than the seed has (an old
    // copy): its media would show the wrong scenes.
    readyTemplate(org, SEED.videoId, null, { plan: PLAN });
    // A member's own index of a seeded Short.
    const other = await signedIn();
    readyTemplate(String(other.me.activeOrganizationId), SEED.videoId, null, {
      user: other.me.id,
      plan: SEED.plan,
    });
    const plans = [
      await session.rpc.director.plan({ videoId: "NotASeed001" }),
      await session.rpc.director.plan({ videoId: SEED.videoId }),
      await other.session.rpc.director.plan({ videoId: SEED.videoId }),
    ];
    expect(plans.map((plan) => plan.source)).toEqual(["seed", "seed", "user"]);
    for (const plan of plans) {
      expect(JSON.stringify(plan)).not.toMatch(/Url"|Key"|files\//);
    }
  });
});

describe("Director", () => {
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
    // It outlives the review job's retries and a backlog ahead of it (packages/jobs).
    expect(source.searchParams.get("X-Amz-Expires")).toBe(String(TAKE_REVIEW_READ_S));

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

describe("Director's voice", { tags: ["files"] }, () => {
  const speeches = () => aiCalls.filter((call) => call.route === "POST /v1/director/speak");

  it("speaks a line once and keeps it, handing back a short-lived link to the WAV file", async () => {
    const { session, me } = await signedIn();
    // Stored lines outlive a run: a line of this run's own.
    const text = `Take a small step to your left. ${randomUUID()}`;
    const before = speeches().length;
    const first = await session.rpc.director.speak({ text: `  ${text} `, voice: "Puck" });
    expect(first.expiresAt).toBeInstanceOf(Date);
    const audio = await fetch(first.url);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await audio.arrayBuffer())).toEqual(spoken(text, "Puck"));
    expect(speeches().slice(before)).toEqual([
      expect.objectContaining({ user: me.id, body: { text, voice: "Puck" } }),
    ]);

    // The same line again, from anyone, is the one already spoken: no second model call.
    const other = await signedIn();
    const again = await other.session.rpc.director.speak({ text, voice: "Puck" });
    expect(Buffer.from(await (await fetch(again.url)).arrayBuffer())).toEqual(spoken(text, "Puck"));
    expect(speeches().length).toBe(before + 1);

    // Another voice is another recording.
    await session.rpc.director.speak({ text, voice: "Kore" });
    expect(speeches().length).toBe(before + 2);
  });

  it("passes on the AI service's refusal, keeping nothing", async () => {
    const { session } = await signedIn();
    const before = speeches().length;
    await expectError(
      session.rpc.director.speak({ text: OVER_BUDGET, voice: "Puck" }),
      "AI_BUDGET_EXCEEDED",
    );
    await expectError(
      session.rpc.director.speak({ text: OVER_BUDGET, voice: "Puck" }),
      "AI_BUDGET_EXCEEDED",
    );
    // Asked again each time: a refusal is never stored as the line.
    expect(speeches().length).toBe(before + 2);
  });

  it("refuses a line that isn't one, before the AI service hears of it", async () => {
    const { session } = await signedIn();
    const before = aiCalls.length;
    await expectError(
      session.rpc.director.speak({ text: "x".repeat(501), voice: "Puck" }),
      "VALIDATION_FAILED",
    );
    await expectError(
      session.rpc.director.speak({ text: "   ", voice: "Puck" }),
      "VALIDATION_FAILED",
    );
    expect(aiCalls.length).toBe(before);
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

  it("lets the member choose a take over Director's pick, and go back to it", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ShotsShort1");
    const best = scoredTake(org, me.id, 90, "2026-10-18T10:00:00Z");
    const second = scoredTake(org, me.id, 70, "2026-10-18T10:01:00Z");
    const [shot] = await session.rpc.director.chooseTake({
      videoId: "ShotsShort1",
      shotIndex: 0,
      takeId: second.id,
    });
    expect(shot).toMatchObject({ pickedTakeId: best.id, chosenTakeId: second.id });
    expect(shot?.takes.find((take) => take.id === best.id)?.reason).toBe("The cleanest delivery.");
    await expect(
      session.rpc.director.chooseTake({ videoId: "ShotsShort1", shotIndex: 0, takeId: null }),
    ).resolves.toMatchObject([{ pickedTakeId: best.id, chosenTakeId: null }]);
    // Someone else's take, or none at all, isn't the member's to choose.
    await expectError(
      session.rpc.director.chooseTake({
        videoId: "ShotsShort1",
        shotIndex: 0,
        takeId: directorTakeIdSchema.parse(randomUUID()),
      }),
      "DIRECTOR_TAKE_NOT_FOUND",
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
    const input = {
      videoId: "CutsShort01",
      picks: { 0: take },
      fileId: file.id,
      title: "Mine",
      durationMs: 14_233,
    };
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
      durationMs: 14_233,
      createdAt: expect.any(Date),
      publish: { status: "none", youtubeVideoId: null, visibility: null },
    });
    expect(aiCalls.at(-1)).toMatchObject({
      route: "POST /v1/director/cuts",
      user: me.id,
      body: {
        picks: [{ shotIndex: 0, takeId: take }],
        fileId: file.id,
        title: "Mine",
        durationMs: 14_233,
      },
    });
    await expect(session.rpc.director.cuts({ videoId: "CutsShort01" })).resolves.toEqual([cut]);
    await expect(session.rpc.director.media()).resolves.toEqual([cut]);
    // A pick that isn't the member's take of that shot, as the AI service says.
    await expectError(
      session.rpc.director.saveCut({ ...input, picks: { 0: SOMEONE_ELSES_TAKE } }),
      "DIRECTOR_TAKE_NOT_FOUND",
    );
  });

  it("hands the AI service each take of a match cut with the type it's stored as", async () => {
    const { session, me } = await signedIn();
    readyTemplate(String(me.activeOrganizationId), "MatchCuts01");
    const take = async (type: "video/webm" | "video/mp4") => {
      const { file } = await session.rpc.files.createUpload({
        purpose: "director-take-video",
        filename: type === "video/webm" ? "take.webm" : "take.mp4",
        contentType: type,
        size: 1000,
      });
      await sql(
        "UPDATE files.file SET status = 'ready', content_type = $2, size = 1000, ready_at = now() WHERE id = $1",
        [file.id, type],
      );
      const added = await session.rpc.director.addTake({
        videoId: "MatchCuts01",
        shotIndex: 0,
        kind: "video",
        fileId: file.id,
      });
      // Reviewed, as the AI service would have it by now.
      const stored = takes.find((each) => each.id === added.id);
      if (stored) {
        stored.score = 80;
      }
      return { take: added.id, file: file.id };
    };
    const [outgoing, incoming] = [await take("video/webm"), await take("video/mp4")];
    const align = () =>
      session.rpc.director.alignMatchCut({
        videoId: "MatchCuts01",
        anchor: "the watch",
        outgoing: { takeId: outgoing.take, atMs: 1500 },
        incoming: { takeId: incoming.take, atMs: 0 },
      });
    await align();
    expect(aiCalls.at(-1)).toMatchObject({
      route: "POST /v1/director/match-cuts",
      body: {
        outgoing: { atMs: 1500, contentType: "video/webm" },
        incoming: { atMs: 0, contentType: "video/mp4" },
      },
    });
    // A take that isn't reviewed yet, or isn't one of the member's, has nothing to line up.
    const reviewing = takes.find((each) => each.id === outgoing.take);
    if (reviewing) {
      reviewing.score = null;
    }
    await expectError(align(), "DIRECTOR_TAKE_NOT_FOUND");
    if (reviewing) {
      reviewing.score = 80;
    }
    await expectError(
      session.rpc.director.alignMatchCut({
        videoId: "MatchCuts01",
        anchor: "the watch",
        outgoing: { takeId: directorTakeIdSchema.parse(randomUUID()), atMs: 0 },
        incoming: { takeId: incoming.take, atMs: 0 },
      }),
      "DIRECTOR_TAKE_NOT_FOUND",
    );
    // A take's file that's no video (it never is): no type to read it as, so no take.
    await sql("UPDATE files.file SET content_type = 'image/jpeg' WHERE id = $1", [incoming.file]);
    await expectError(align(), "DIRECTOR_TAKE_NOT_FOUND");
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
    // Past what the worker can scan (ClamAV's default stream limit), it never uploads.
    const tooBig = await expectError(
      session.rpc.files.createUpload({
        purpose: "director-cut-video",
        filename: "long.mp4",
        contentType: "video/mp4",
        size: 100_000_001,
      }),
      "FILE_TOO_LARGE",
    );
    expect(tooBig.data).toMatchObject({ params: { maxBytes: 100_000_000 } });
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

describe("Director's slower line", () => {
  const turn = (videoId: string, text = "Can you hear me?") => ({
    videoId,
    shotIndex: 0,
    turn: { kind: "said" as const, text },
    adaptations: [],
    recent: [],
    answers: [],
  });
  const ledgerCalls = (org: string) =>
    aiCalls.filter((call) => call.org === org && call.route.includes("/chat-"));

  it("counts each turn in the AI service's ledger: reserved, then settled with what it cost", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ChatShort01");
    expect(await session.rpc.director.chat(turn("ChatShort01"))).toEqual({
      reply: "Got it.",
      calls: [],
    });
    expect(ledgerCalls(org)).toEqual([
      expect.objectContaining({
        route: "POST /v1/director/chat-reservations",
        user: me.id,
        body: { model: expect.any(String) },
      }),
      expect.objectContaining({
        route: "POST /v1/director/chat-usage",
        body: {
          model: expect.any(String),
          reserved: 20_000,
          inputTokens: CHAT_USAGE.promptTokenCount,
          outputTokens: CHAT_USAGE.totalTokenCount - CHAT_USAGE.promptTokenCount,
        },
      }),
    ]);
  });

  it("settles a turn Gemini failed too, with nothing spent", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ChatShort02");
    google.chatOutage(true);
    try {
      await expectError(session.rpc.director.chat(turn("ChatShort02")), "UPSTREAM_UNAVAILABLE");
    } finally {
      google.chatOutage(false);
    }
    expect(ledgerCalls(org).map((call) => call.body)).toEqual([
      { model: expect.any(String) },
      { model: expect.any(String), reserved: 20_000, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("settles a turn whose answer didn't say what it cost with the whole reservation", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ChatShort05");
    google.chatUncounted(true);
    try {
      expect((await session.rpc.director.chat(turn("ChatShort05"))).reply).toBe("Got it.");
    } finally {
      google.chatUncounted(false);
    }
    expect(ledgerCalls(org).map((call) => call.body)).toEqual([
      { model: expect.any(String) },
      { model: expect.any(String), reserved: 20_000, inputTokens: 20_000, outputTokens: 0 },
    ]);
  });

  it("answers the member even when the ledger fails to settle the turn", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ChatShort07");
    unsettledOrgs.add(org);
    expect((await session.rpc.director.chat(turn("ChatShort07"))).reply).toBe("Got it.");
    expect(ledgerCalls(org).map((call) => call.route)).toEqual([
      "POST /v1/director/chat-reservations",
      "POST /v1/director/chat-usage",
    ]);
  });

  it("answers DIRECTOR_PLAN_NOT_FOUND for a plan still being written, before the ledger", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    plans.unshift({
      id: randomUUID(),
      org,
      user: me.id,
      videoId: "ChatShort06",
      status: "pending",
      audioKey: null,
    });
    await expectError(session.rpc.director.chat(turn("ChatShort06")), "DIRECTOR_PLAN_NOT_FOUND");
    expect(ledgerCalls(org)).toEqual([]);
  });

  it("asks Gemini nothing once the workspace's allowance is spent", async () => {
    const { session, me } = await signedIn();
    const org = String(me.activeOrganizationId);
    readyTemplate(org, "ChatShort03");
    spentOrgs.add(org);
    await expectError(session.rpc.director.chat(turn("ChatShort03")), "AI_BUDGET_EXCEEDED");
    expect(ledgerCalls(org).map((call) => call.route)).toEqual([
      "POST /v1/director/chat-reservations",
    ]);
  });

  it("holds a member to about as many turns as a person can say", async () => {
    const { session, me } = await signedIn();
    readyTemplate(String(me.activeOrganizationId), "ChatShort04");
    for (let i = 0; i < 10; i++) {
      await session.rpc.director.chat(turn("ChatShort04"));
    }
    await expectError(session.rpc.director.chat(turn("ChatShort04")), "RATE_LIMITED");
  });
});
