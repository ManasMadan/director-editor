/**
 * Google sign-in, and publishing a cut to YouTube Shorts, through the real API.
 *
 * Google is packages/fake-google: its sign-in (OAuth with OpenID Connect) and YouTube's
 * resumable upload. better-auth calls Google's own hosts, so a test sends exactly those
 * requests to the fake (`throughFakeGoogle` in the harness), the way password-breach.integration.test.ts
 * stands in for Have I Been Pwned; the API reaches YouTube through YOUTUBE_API_URL. The
 * AI service is a stand-in answering cuts from the database as apps/ai does (as app_ai,
 * under row-level security), and a cut's video sits in the local object storage.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { zAssetSlotsOut } from "@repo/ai-client/schemas";
import { PUBLISH_DAILY_LIMIT } from "@repo/contracts/api";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { startFakeGoogle } from "@repo/fake-google";
import { S3Storage } from "@repo/nest-common";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaDay } from "../src/modules/publish/quota-day";
import {
  createSession,
  googleConsent,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  startApi,
  takeOtp,
  throughFakeGoogle,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;
const KEY = "test-youtube-key";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
/** The first seeded template's Short, which every cut here is made of. */
const ORIGINAL = directorSeeds[0]?.videoId;
const VIDEO = Buffer.from("00000018667479706d703432", "hex");

let harness: Harness;
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
let ai: Server;
let aiDb: pg.Pool;
const copyAsks: unknown[] = [];
/**
 * The gap's B-roll the member chose, when a test gives one: a Veo clip is AI footage.
 * `unreadable`: the AI service fails to list the plan's slots.
 */
const chosen: { clip: boolean; unreadable: boolean } = { clip: false, unreadable: false };

const storage = new S3Storage({
  bucket: LOCAL_STORAGE.S3_BUCKET,
  region: "us-east-1",
  endpoint: LOCAL_STORAGE.S3_ENDPOINT,
  accessKeyId: LOCAL_STORAGE.S3_ACCESS_KEY_ID,
  secretAccessKey: LOCAL_STORAGE.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
});

async function sql<T extends pg.QueryResultRow>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query<T>(query, params)).rows;
  } finally {
    await client.end();
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function caller(request: IncomingMessage) {
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    issuer: "api",
    audience: "ai",
  });
  return { org: String(payload.org), user: String(payload.sub) };
}

interface CutRow {
  id: string;
  planId: string;
  videoId: string;
  title: string;
  fileId: string;
  durationMs: number;
  publishStatus: string;
  youtubeVideoId: string | null;
  visibility: string | null;
  createdAt: Date;
}

/** A cut of the caller's, read as apps/ai reads it: as app_ai, in the caller's workspace. */
async function cutOf(who: { org: string; user: string }, cutId: string) {
  const client = await aiDb.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [who.org]);
    const { rows } = await client.query<CutRow>(
      `SELECT cut.id, plan.id AS "planId", plan.video_id AS "videoId", cut.title,
              cut.file_id AS "fileId", cut.duration_ms AS "durationMs",
              cut.publish_status AS "publishStatus", cut.youtube_video_id AS "youtubeVideoId",
              cut.visibility, cut.created_at AS "createdAt"
         FROM ai.director_cut AS cut JOIN ai.director_plan AS plan ON plan.id = cut.plan_id
        WHERE cut.id = $1 AND cut.user_id = $2`,
      [cutId, who.user],
    );
    await client.query("COMMIT");
    return rows[0];
  } finally {
    client.release();
  }
}

const COPY = {
  title: "Three looks, one mirror",
  description: "My take on the trend.",
  hashtags: ["grwm", "fitcheck"],
  credits: "Inspired by the original, recreated with Director.",
};

/** The plan's asset slots, as apps/ai lists them: one gap, and the member's clip for it. */
function assetSlots(videoId: string) {
  const clip = randomUUID();
  return zAssetSlotsOut.parse({
    slots: [
      {
        assetId: "gap-1",
        prompt: "A kettle coming to the boil",
        candidates: [
          {
            id: clip,
            assetId: "gap-1",
            origin: "created",
            status: "ready",
            objectKey: `director-assets/${videoId}/gap-1/${clip}.mp4`,
            fileId: null,
            error: null,
            prompt: "A kettle coming to the boil",
            credit: null,
            createdAt: new Date().toISOString(),
          },
        ],
        chosenId: chosen.clip ? clip : null,
        history: [],
      },
    ],
    imagesUsed: 1,
    imagesPerVideo: 10,
    imagesToday: 1,
    imagesPerDay: 30,
  });
}

/** apps/ai's routes for a cut: reading one, its plan's assets, and Gemini's copy for it. */
async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const who = await caller(request);
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const notFound = () =>
    send(response, 404, {
      defined: true,
      code: "DIRECTOR_CUT_NOT_FOUND",
      status: 404,
      message: "not found",
      data: { params: {} },
    });
  const read = /^\/v1\/director\/cuts\/([\w-]+)$/.exec(request.url ?? "");
  if (request.method === "GET" && read?.[1]) {
    const cut = await cutOf(who, read[1]);
    if (!cut) {
      return notFound();
    }
    return send(response, 200, {
      ...cut,
      templateTitle: "Get ready with me",
      picks: [],
      createdAt: cut.createdAt.toISOString(),
    });
  }
  const assets = /^\/v1\/director\/plans\/([\w-]+)\/assets$/.exec(request.url ?? "");
  if (request.method === "GET" && assets?.[1]) {
    return chosen.unreadable ? send(response, 500, {}) : send(response, 200, assetSlots(assets[1]));
  }
  if (request.method === "POST" && request.url === "/v1/director/publish-copy") {
    copyAsks.push(body);
    const { cutId } = body as { cutId: string };
    return (await cutOf(who, cutId)) ? send(response, 200, COPY) : notFound();
  }
  send(response, 404, {});
}

beforeAll(async () => {
  google = await startFakeGoogle({ apiKey: KEY });
  ai = createServer((request, response) => {
    aiRoute(request, response).catch(() => send(response, 401, {}));
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  harness = await startApi(28, {
    ...LOCAL_STORAGE,
    GOOGLE_CLIENT_ID: "director-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "director-test-secret",
    YOUTUBE_API_KEY: KEY,
    YOUTUBE_API_URL: `${google.url}/youtube/v3`,
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
  });
  aiDb = new pg.Pool({ connectionString: harness.testDb.urlFor("app_ai"), max: 2 });
});

afterAll(async () => {
  await aiDb?.end();
  await harness?.close();
  await google?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
  chosen.clip = false;
  chosen.unreadable = false;
});

type Session = ReturnType<typeof createSession>;

/** Google's consent, through the fake (googleConsent in the harness). */
const consent = (session: Session, started: { status: number; body: { url: string } }) =>
  googleConsent(harness, google.url, session, started);

/** Someone who signs in with Google only (no password). */
async function signInWithGoogle(email = newEmail()) {
  const session = createSession(harness);
  const started = await session.auth<{ url: string }>("/sign-in/social", {
    provider: "google",
    callbackURL: process.env.WEB_URL,
    loginHint: email,
  });
  const callback = await consent(session, started);
  expect(callback.status).toBe(302);
  return { session, email, me: await session.rpc.user.me() };
}

/** Lets Director upload to the member's YouTube channel, as the publish sheet asks. */
async function allowYouTube(session: Session, email: string) {
  const started = await session.auth<{ url: string }>("/link-social", {
    provider: "google",
    scopes: [UPLOAD_SCOPE],
    callbackURL: process.env.WEB_URL,
    loginHint: email,
  });
  expect((await consent(session, started)).status).toBe(302);
}

async function signedUpWithPassword(email = newEmail()) {
  const session = createSession(harness);
  const password = newPassword();
  await session.auth("/sign-up/email", { email, password, name: "Director" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, password, me: await session.rpc.user.me() };
}

/** A ready cut of the member's, its video in storage, of a seeded template's plan. */
async function aCut(me: { id: string; activeOrganizationId?: string | null }, inStorage = true) {
  const org = String(me.activeOrganizationId);
  const [plan] = await sql<{ id: string }>(
    "SELECT id FROM ai.director_plan WHERE org_id = $1 AND video_id = $2",
    [org, ORIGINAL],
  );
  const [file] = await sql<{ id: string }>(
    `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size,
                             content_type, size, ready_at, updated_at)
     VALUES ($1, 'director-cut-video', 'ready', 'cut.mp4', 'video/mp4', $2, 'video/mp4', $2, now(), now())
     RETURNING id`,
    [me.id, VIDEO.length],
  );
  if (inStorage) {
    await storage.write(`files/${file?.id}`, VIDEO, "video/mp4");
  }
  const [cut] = await sql<{ id: string }>(
    `INSERT INTO ai.director_cut (org_id, plan_id, user_id, title, picks, file_id, duration_ms, updated_at)
     VALUES ($1, $2, $3, 'My look', '[]', $4, 4000, now()) RETURNING id`,
    [org, plan?.id, me.id, file?.id],
  );
  return { cutId: String(cut?.id), fileId: String(file?.id) };
}

const publishInput = (cutId: string) => ({ cutId, ...COPY, visibility: "public" as const });

/** The day's count of videos Director sent to YouTube, as the API keeps it in Redis. */
const todaysKey = () => `publish:uploads:${quotaDay(new Date())}`;
const uploadsToday = async () => Number((await harness.redis.get(todaysKey())) ?? 0);

/**
 * A cut of the member's of a Short of their own (one of their seeds, moved to `videoId`),
 * with no video in storage: for the copy, which reads the Short as YouTube shows it.
 */
async function cutOfShort(
  me: { id: string; activeOrganizationId?: string | null },
  videoId: string,
) {
  await sql("UPDATE ai.director_plan SET video_id = $3 WHERE org_id = $1 AND video_id = $2", [
    me.activeOrganizationId,
    ORIGINAL,
    videoId,
  ]);
  const [plan] = await sql<{ id: string }>(
    "SELECT id FROM ai.director_plan WHERE org_id = $1 AND video_id = $2",
    [me.activeOrganizationId, videoId],
  );
  const [file] = await sql<{ id: string }>(
    `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
     VALUES ($1, 'director-cut-video', 'ready', 'cut.mp4', 'video/mp4', 10, now()) RETURNING id`,
    [me.id],
  );
  const [cut] = await sql<{ id: string }>(
    `INSERT INTO ai.director_cut (org_id, plan_id, user_id, title, picks, file_id, duration_ms, updated_at)
     VALUES ($1, $2, $3, 'Mine', '[]', $4, 1000, now()) RETURNING id`,
    [me.activeOrganizationId, plan?.id, me.id, file?.id],
  );
  return String(cut?.id);
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

describe("Google sign-in", () => {
  it("creates a user with their personal workspace and its 6 seeded templates", async () => {
    const { me, email } = await signInWithGoogle();
    expect(me.email).toBe(email);
    const [workspace] = await sql<{ slug: string; seeds: number }>(
      `SELECT org.slug, (SELECT count(*)::int FROM ai.director_plan AS plan
                          WHERE plan.org_id = org.id AND plan.source = 'seed') AS seeds
         FROM auth.organization AS org WHERE org.id = $1`,
      [me.activeOrganizationId],
    );
    expect(workspace).toEqual({ slug: `personal-${me.id}`, seeds: directorSeeds.length });
    expect(directorSeeds).toHaveLength(6);
    const [account] = await sql<{ scope: string }>(
      "SELECT scope FROM auth.account WHERE user_id = $1 AND provider_id = 'google'",
      [me.id],
    );
    expect(account?.scope.split(",").sort()).toEqual(["email", "openid", "profile"]);
  });
});

describe("publishing a cut", { tags: ["files"] }, () => {
  // Every test here publishes, past the day's cap together: each starts the day afresh.
  beforeEach(() => harness.redis.del(todaysKey()));

  it("refuses the demo account, and nothing reaches YouTube", async () => {
    const { email, password, me } = await signedUpWithPassword();
    const { cutId } = await aCut(me);
    await sql('UPDATE auth."user" SET demo = true WHERE id = $1', [me.id]);
    // A new session: a session's user is read when it signs in.
    const demo = createSession(harness);
    await demo.auth("/sign-in/email", { email, password });
    const uploads = google.uploads.length;
    await expectError(demo.rpc.publish.upload(publishInput(cutId)), "PUBLISH_DEMO_DISABLED");
    expect(google.uploads.length).toBe(uploads);
    expect(
      (await cutOf({ org: String(me.activeOrganizationId), user: me.id }, cutId))?.publishStatus,
    ).toBe("none");
  });

  it("refuses a cut whose video isn't checked yet or is gone from storage, before YouTube", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const uploads = google.uploads.length;
    const missing = await aCut(me, false);
    await expectError(
      session.rpc.publish.upload(publishInput(missing.cutId)),
      "PUBLISH_CUT_NOT_READY",
    );
    const unchecked = await aCut(me);
    await sql("UPDATE files.file SET status = 'pending' WHERE id = $1", [unchecked.fileId]);
    await expectError(
      session.rpc.publish.upload(publishInput(unchecked.cutId)),
      "PUBLISH_CUT_NOT_READY",
    );
    expect(google.uploads.length).toBe(uploads);
  });

  it("asks for YouTube while no Google account of the member's allows uploads", async () => {
    const withPassword = await signedUpWithPassword();
    const { cutId } = await aCut(withPassword.me);
    await expectError(
      withPassword.session.rpc.publish.upload(publishInput(cutId)),
      "PUBLISH_NEEDS_YOUTUBE",
    );
    const signInOnly = await signInWithGoogle();
    const theirs = await aCut(signInOnly.me);
    await expectError(
      signInOnly.session.rpc.publish.upload(publishInput(theirs.cutId)),
      "PUBLISH_NEEDS_YOUTUBE",
    );
  });

  it("declares a video with a Veo clip in a gap as altered or synthetic content", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    chosen.clip = true;
    await session.rpc.publish.upload(publishInput(cutId));
    expect(google.uploads.at(-1)?.status.containsSyntheticMedia).toBe(true);
  });

  it("sends nothing to YouTube when it can't tell whether the video has AI footage", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const uploads = google.uploads.length;
    chosen.unreadable = true;
    await expectError(session.rpc.publish.upload(publishInput(cutId)), "UPSTREAM_UNAVAILABLE");
    expect(google.uploads.length).toBe(uploads);
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect((await cutOf(who, cutId))?.publishStatus).toBe("none");
    // Once the AI service answers again, it goes.
    chosen.unreadable = false;
    await session.rpc.publish.upload(publishInput(cutId));
    expect(google.uploads.length).toBe(uploads + 1);
  });

  it("publishes the cut to the member's channel and stores YouTube's id", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    // Imported here, not at the top: the API reads its environment once, at first import,
    // and startApi sets it.
    const { AnalyticsService } = await import("../src/modules/analytics");
    const record = vi.spyOn(harness.app.get(AnalyticsService), "record");
    const cut = await session.rpc.publish.upload(publishInput(cutId));
    const upload = google.uploads.at(-1);
    expect(upload).toMatchObject({
      email,
      bytes: VIDEO.length,
      contentType: "video/mp4",
      snippet: { title: "Three looks, one mirror #Shorts" },
      // No AI footage in it: nothing to declare.
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
    });
    expect(upload?.snippet.description).toBe(
      `My take on the trend.\n\n#grwm #fitcheck\n\n${COPY.credits}\nhttps://youtube.com/shorts/${ORIGINAL}`,
    );
    // YouTube keeps an unaudited app's uploads private, and the cut says so.
    expect(cut.publish).toEqual({
      status: "published",
      youtubeVideoId: upload?.id,
      visibility: "private",
    });
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect(await cutOf(who, cutId)).toMatchObject({
      publishStatus: "published",
      youtubeVideoId: upload?.id,
      visibility: "private",
    });
    expect(record).toHaveBeenCalledWith("published", {
      userId: me.id,
      videoId: ORIGINAL,
      detail: { youtubeVideoId: upload?.id, asked: "public", privacyStatus: "private" },
    });
    // Published once: asking again answers the cut as it is.
    const uploads = google.uploads.length;
    await expect(session.rpc.publish.upload(publishInput(cutId))).resolves.toEqual(cut);
    expect(google.uploads.length).toBe(uploads);
  });

  it("refreshes an access token that has run out", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    await sql(
      "UPDATE auth.account SET access_token_expires_at = now() - interval '1 hour' WHERE user_id = $1",
      [me.id],
    );
    const { cutId } = await aCut(me);
    throughFakeGoogle(google.url);
    const cut = await session.rpc.publish.upload(publishInput(cutId));
    expect(cut.publish.status).toBe("published");
  });

  it("says when the Google account has no YouTube channel, and lets the member try again", async () => {
    const { session, email, me } = await signInWithGoogle(`no-channel-${randomUUID()}@test.dev`);
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    await expectError(session.rpc.publish.upload(publishInput(cutId)), "PUBLISH_NO_CHANNEL");
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect((await cutOf(who, cutId))?.publishStatus).toBe("failed");
  });

  it("uploads a cut once when it's published twice at once", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const uploads = google.uploads.length;
    const both = await Promise.all([
      session.rpc.publish.upload(publishInput(cutId)),
      session.rpc.publish.upload(publishInput(cutId)),
    ]);
    expect(google.uploads.length).toBe(uploads + 1);
    expect(both.map((cut) => cut.publish.status)).toContain("published");
  });

  it("leaves a publish under way alone, and takes over one cut off long ago", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const uploads = google.uploads.length;
    await sql("UPDATE ai.director_cut SET publish_status = 'uploading' WHERE id = $1", [cutId]);
    const underWay = await session.rpc.publish.upload(publishInput(cutId));
    expect(underWay.publish.status).toBe("uploading");
    expect(google.uploads.length).toBe(uploads);
    // Nothing went to YouTube, so the day's place it took is given back.
    expect(await uploadsToday()).toBe(0);
    // The API restarted mid-upload: nothing will finish it.
    await sql("UPDATE ai.director_cut SET updated_at = now() - interval '1 hour' WHERE id = $1", [
      cutId,
    ]);
    const published = await session.rpc.publish.upload(publishInput(cutId));
    expect(published.publish.status).toBe("published");
    expect(google.uploads.length).toBe(uploads + 1);
  });

  it("asks for YouTube again when Google no longer lets it upload or refresh", async () => {
    // The scope is on record, but the token Google issued was never granted it.
    const revoked = await signInWithGoogle();
    await sql(
      "UPDATE auth.account SET scope = scope || $2 WHERE user_id = $1 AND provider_id = 'google'",
      [revoked.me.id, `,${UPLOAD_SCOPE}`],
    );
    const theirs = await aCut(revoked.me);
    await expectError(
      revoked.session.rpc.publish.upload(publishInput(theirs.cutId)),
      "PUBLISH_NEEDS_YOUTUBE",
    );
    const who = { org: String(revoked.me.activeOrganizationId), user: revoked.me.id };
    expect((await cutOf(who, theirs.cutId))?.publishStatus).toBe("failed");
    // The access token ran out, and the refresh token is one Google won't take.
    const expired = await signInWithGoogle();
    await allowYouTube(expired.session, expired.email);
    await sql(
      `UPDATE auth.account SET access_token_expires_at = now() - interval '1 hour',
                               refresh_token = 'not-a-token' WHERE user_id = $1`,
      [expired.me.id],
    );
    const cut = await aCut(expired.me);
    await expectError(
      expired.session.rpc.publish.upload(publishInput(cut.cutId)),
      "PUBLISH_NEEDS_YOUTUBE",
    );
  });

  it("uploads an older cut once when it's published twice at once", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    // Saved an hour ago: as old as a publish cut off long ago would be.
    await sql("UPDATE ai.director_cut SET updated_at = now() - interval '1 hour' WHERE id = $1", [
      cutId,
    ]);
    const uploads = google.uploads.length;
    await Promise.all([
      session.rpc.publish.upload(publishInput(cutId)),
      session.rpc.publish.upload(publishInput(cutId)),
    ]);
    expect(google.uploads.length).toBe(uploads + 1);
    expect(await uploadsToday()).toBe(1);
  });

  it("stops at the day's cap before YouTube, counting only what YouTube took", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const uploads = google.uploads.length;
    await harness.redis.set(todaysKey(), PUBLISH_DAILY_LIMIT);
    await expectError(session.rpc.publish.upload(publishInput(cutId)), "PUBLISH_QUOTA_EXHAUSTED");
    expect(google.uploads.length).toBe(uploads);
    expect(await uploadsToday()).toBe(PUBLISH_DAILY_LIMIT);
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect((await cutOf(who, cutId))?.publishStatus).toBe("none");
    // The last of the day's places, and it's gone at midnight UTC.
    await harness.redis.set(todaysKey(), PUBLISH_DAILY_LIMIT - 1);
    await expect(session.rpc.publish.upload(publishInput(cutId))).resolves.toMatchObject({
      publish: { status: "published" },
    });
    expect(await uploadsToday()).toBe(PUBLISH_DAILY_LIMIT);
    const ttl = await harness.redis.ttl(todaysKey());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("keeps the day's place once YouTube has opened the session, even when the file fails", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    google.breakUploads(true);
    try {
      await expectError(session.rpc.publish.upload(publishInput(cutId)), "UPSTREAM_UNAVAILABLE");
    } finally {
      google.breakUploads(false);
    }
    // The insert counts against YouTube's quota: so it does against the day's places.
    expect(await uploadsToday()).toBe(1);
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect((await cutOf(who, cutId))?.publishStatus).toBe("failed");
  });

  it("gives the day's place back when claiming the cut fails outright", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const { PublishRepository } = await import("../src/modules/publish/publish.repository");
    vi.spyOn(harness.app.get(PublishRepository), "claim").mockRejectedValueOnce(
      new Error("the database went away"),
    );
    const uploads = google.uploads.length;
    await expectError(session.rpc.publish.upload(publishInput(cutId)), "INTERNAL");
    expect(await uploadsToday()).toBe(0);
    expect(google.uploads.length).toBe(uploads);
  });

  it("says what YouTube said even when marking the cut failed doesn't work", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    const { PublishRepository } = await import("../src/modules/publish/publish.repository");
    vi.spyOn(harness.app.get(PublishRepository), "failed").mockRejectedValueOnce(
      new Error("the database went away"),
    );
    google.exhaustQuota(true);
    try {
      await expectError(session.rpc.publish.upload(publishInput(cutId)), "PUBLISH_QUOTA_EXHAUSTED");
    } finally {
      google.exhaustQuota(false);
    }
    expect(await uploadsToday()).toBe(0);
  });

  it("never fails giving a place back, whatever Redis does", async () => {
    const { DailyAllowance } = await import("../src/modules/publish/daily-allowance");
    const allowance = harness.app.get(DailyAllowance);
    const day = await allowance.take();
    expect(await uploadsToday()).toBe(1);
    const { Redis } = await import("ioredis");
    vi.spyOn(Redis.prototype, "multi").mockImplementationOnce(() => {
      throw new Error("Redis went away");
    });
    await expect(allowance.giveBack(day)).resolves.toBeUndefined();
    // Not given back: the count errs on the side of YouTube's quota until the day ends.
    expect(await uploadsToday()).toBe(1);
  });

  it("says when YouTube's quota is spent, and gives the day's place back", async () => {
    const { session, email, me } = await signInWithGoogle();
    await allowYouTube(session, email);
    const { cutId } = await aCut(me);
    google.exhaustQuota(true);
    try {
      await expectError(session.rpc.publish.upload(publishInput(cutId)), "PUBLISH_QUOTA_EXHAUSTED");
    } finally {
      google.exhaustQuota(false);
    }
    expect(await uploadsToday()).toBe(0);
    const who = { org: String(me.activeOrganizationId), user: me.id };
    expect((await cutOf(who, cutId))?.publishStatus).toBe("failed");
  });

  it("publishes only the member's own cut", async () => {
    const owner = await signInWithGoogle();
    const { cutId } = await aCut(owner.me);
    const other = await signInWithGoogle();
    await allowYouTube(other.session, other.email);
    await expectError(
      other.session.rpc.publish.upload(publishInput(cutId)),
      "DIRECTOR_CUT_NOT_FOUND",
    );
  });
});

describe("the copy for a cut", () => {
  it("is Gemini's, written knowing the original as YouTube shows it", async () => {
    const { session, me } = await signInWithGoogle();
    const { cutId } = await aCut(me, false);
    await expect(session.rpc.publish.copy({ cutId })).resolves.toEqual(COPY);
    const original = { title: expect.any(String), channel: expect.any(String) };
    expect(copyAsks.at(-1)).toEqual({ cutId, original });
    // Asked again, the original comes from the API's cache, and is the same.
    await session.rpc.publish.copy({ cutId });
    expect(copyAsks.at(-1)).toEqual(copyAsks.at(-2));
    const other = await signInWithGoogle();
    await expectError(other.session.rpc.publish.copy({ cutId }), "DIRECTOR_CUT_NOT_FOUND");
  });

  it("is written for the demo too, which may read the post but not send it", async () => {
    const { email, password, me } = await signedUpWithPassword();
    const { cutId } = await aCut(me, false);
    await sql('UPDATE auth."user" SET demo = true WHERE id = $1', [me.id]);
    // A new session: a session's user is read when it signs in.
    const demo = createSession(harness);
    await demo.auth("/sign-in/email", { email, password });
    await expect(demo.rpc.publish.copy({ cutId })).resolves.toEqual(COPY);
  });

  it("is written without the original once YouTube no longer shows it", async () => {
    const { session, me } = await signInWithGoogle();
    const cutId = await cutOfShort(me, "GoneShort01");
    await expect(session.rpc.publish.copy({ cutId })).resolves.toEqual(COPY);
    expect(copyAsks.at(-1)).toEqual({ cutId, original: null });
  });

  it("is written without the original while YouTube can't be read", async () => {
    const { session, me } = await signInWithGoogle();
    const cutId = await cutOfShort(me, "QuotaShort1");
    google.exhaustQuota(true);
    try {
      await expect(session.rpc.publish.copy({ cutId })).resolves.toEqual(COPY);
    } finally {
      google.exhaustQuota(false);
    }
    expect(copyAsks.at(-1)).toEqual({ cutId, original: null });
  });
});
