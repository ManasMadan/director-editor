/**
 * Director's continuous recording in the worker: cutting an ended attempt into a take
 * through the AI service, and the retention that deletes raw footage and finishes the
 * sessions left open. Against a real (cloned) database as app_worker, a private Redis
 * database, the local object storage, and a stand-in for the AI service that answers its
 * clip and take routes the way apps/ai does (apps/ai's own tests cut real footage).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { orgIdSchema, recordingAttemptIdSchema } from "@repo/contracts/ids";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { queuePrefix, queues } from "@repo/jobs";
import { createRedis, S3Storage, STORAGE, type Storage } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import { Queue } from "bullmq";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceProcessor as Maintenance } from "../src/maintenance/maintenance.processor";
import type { ClipProcessor as Clipper } from "../src/recording/clip.processor";

const SECRET = `test-ai-secret-${randomUUID()}`;
const S3 = {
  S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:59000",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "rustfs",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "rustfs-secret",
  S3_FORCE_PATH_STYLE: "true",
};
const storage = new S3Storage({
  bucket: S3.S3_BUCKET,
  region: "us-east-1",
  endpoint: S3.S3_ENDPOINT,
  accessKeyId: S3.S3_ACCESS_KEY_ID,
  secretAccessKey: S3.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
});
/** What the stand-in clipper answers with: an MP4's first bytes. */
const MP4 = Buffer.from("\x00\x00\x00\x20ftypisom-take", "latin1");

let testDb: TestDatabase;
let app: INestApplicationContext;
let clipper: Clipper;
let maintenance: Maintenance;
let ai: Server;

/**
 * How the stand-in answers next: as it should, as a failing or refusing one, or with the
 * member deleting the session (or another run claiming the attempt's file) meanwhile.
 */
const mode = { clip: "ok", take: "ok" };
const clipRequests: { org: string; body: ClipBody; slices: string[] }[] = [];
const takeRequests: { org: string; user: string; body: Record<string, unknown>; take: Buffer }[] =
  [];

interface ClipBody {
  attemptId: string;
  contentType: string;
  slices: { url: string; startMs: number; durationMs: number }[];
  startMs: number;
  endMs: number | null;
  pauses: { startMs: number; endMs: number | null }[];
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const failure = (status: number, code: string) => ({
  defined: true,
  code,
  status,
  message: code,
  data: { params: {} },
});

async function readAll(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

/** Fetches a presigned read, as the clipper and the review do. */
async function fetched(url: string) {
  const response = await fetch(url);
  expect(response.ok, url).toBe(true);
  return Buffer.from(await response.arrayBuffer());
}

/** The member deleting the session the attempt is of, as "delete this session" does. */
function deleteSessionOf(attemptId: string) {
  return sql(
    `DELETE FROM app.recording_session
      WHERE id = (SELECT session_id FROM app.recording_attempt WHERE id = $1)`,
    [attemptId],
  );
}

/** Another run of the same attempt's job making its file first. */
async function claimFile(attemptId: string) {
  const [file] = await sql<{ id: string }>(
    `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
     SELECT s.user_id, 'director-take-video', 'processing', 'attempt-1.mp4', 'video/mp4', 10, now()
       FROM app.recording_attempt a JOIN app.recording_session s ON s.id = a.session_id
      WHERE a.id = $1 RETURNING id`,
    [attemptId],
  );
  await sql("UPDATE app.recording_attempt SET file_id = $1 WHERE id = $2", [file?.id, attemptId]);
}

/** Deletes the session whose attempt has this take's file, as "delete this session" does. */
function deleteSessionOfFile(fileId: unknown) {
  return sql(
    "DELETE FROM app.recording_session WHERE id = (SELECT session_id FROM app.recording_attempt WHERE file_id = $1)",
    [fileId],
  );
}

/** The clip route: fetches the footage it's sent, and answers as `mode.clip` says. */
async function clipRoute(org: string, clip: ClipBody, response: ServerResponse) {
  const slices = await Promise.all(
    clip.slices.map(async (slice) => (await fetched(slice.url)).toString()),
  );
  clipRequests.push({ org, body: clip, slices });
  if (mode.clip === "delete") {
    await deleteSessionOf(clip.attemptId);
  }
  if (mode.clip === "claim") {
    await claimFile(clip.attemptId);
  }
  if (mode.clip === "down") {
    return send(response, 502, failure(502, "UPSTREAM_UNAVAILABLE"));
  }
  if (mode.clip === "refuse") {
    return send(response, 422, failure(422, "RECORDING_CLIP_FAILED"));
  }
  response.writeHead(200, {
    "content-type": "video/mp4",
    "x-clip-start-ms": String(clip.startMs - 250),
    "x-clip-end-ms": String((clip.endMs ?? 20_000) + 250),
  });
  return response.end(MP4);
}

/** The take route: records the take as apps/ai does, or answers as `mode.take` says. */
async function takeRoute(
  org: string,
  user: string,
  take: Record<string, unknown>,
  response: ServerResponse,
) {
  takeRequests.push({ org, user, body: take, take: await fetched(String(take.sourceUrl)) });
  if (mode.take === "kind") {
    return send(response, 422, failure(422, "DIRECTOR_TAKE_KIND_MISMATCH"));
  }
  if (mode.take === "down") {
    return send(response, 502, failure(502, "UPSTREAM_UNAVAILABLE"));
  }
  if (mode.take === "delete") {
    // Deleted before the take was made: the file is gone, so apps/ai's insert fails.
    await deleteSessionOfFile(take.fileId);
    return send(response, 500, failure(500, "INTERNAL"));
  }
  // A take row as apps/ai writes one (one per file), for the attempt to point at.
  const [row] = await sql<{ id: string }>(
    `INSERT INTO ai.director_take (org_id, plan_id, user_id, shot_index, file_id, kind, updated_at)
     SELECT $1, p.id, $2, $3, $4, 'video', now() FROM ai.director_plan p
      WHERE p.org_id = $1 AND p.video_id = $5
     RETURNING id`,
    [org, user, take.shotIndex, take.fileId, take.videoId],
  );
  if (mode.take === "deleteAfter") {
    await deleteSessionOfFile(take.fileId);
  }
  return send(response, 201, {
    id: row?.id,
    shotIndex: take.shotIndex,
    fileId: take.fileId,
    kind: "video",
    status: "pending",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    reason: null,
    chosen: false,
    origin: "shoot",
    createdAt: new Date().toISOString(),
  });
}

/** The AI service's clip and take routes, checking the token the worker signs. */
async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  // Who the worker says is calling: a token signed with the AI service's secret, as the
  // real service checks it.
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    algorithms: ["HS256"],
  });
  const org = String(payload.org);
  const body: unknown = JSON.parse(await readAll(request));
  if (request.url === "/v1/director/clips") {
    return clipRoute(org, body as ClipBody, response);
  }
  return takeRoute(org, String(payload.sub), body as Record<string, unknown>, response);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  ai = createServer((request, response) => void aiRoute(request, response));
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    WORKER_DATABASE_URL: testDb.urlFor("app_worker"),
    WORKER_DATABASE_DIRECT_URL: testDb.urlFor("app_worker"),
    REDIS_URL: redisDatabase(22),
    ...S3,
    FILE_SCANNER: "none",
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
    LOAD_SHEDDING: "off",
  });
  const redis = createRedis(process.env.REDIS_URL as string);
  await flushTestDatabase(redis);
  await redis.quit();
  const { AppModule } = await import("../src/app.module");
  const { ClipProcessor } = await import("../src/recording/clip.processor");
  const { MaintenanceProcessor } = await import("../src/maintenance/maintenance.processor");
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  clipper = app.get(ClipProcessor);
  maintenance = app.get(MaintenanceProcessor);
});

afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => ai?.close(resolve));
  await testDb?.drop();
});

beforeEach(() => {
  mode.clip = "ok";
  mode.take = "ok";
  clipRequests.length = 0;
  takeRequests.length = 0;
});

interface Arranged {
  org: string;
  user: string;
  session: string;
}

/**
 * A member's recording session on a ready plan, with one part of `slices` ten-second
 * slices stored (their bytes in storage unless `stored` says not), as the API leaves them.
 */
async function recorded(
  slices: number,
  { sliceCount = null, stored = true }: { sliceCount?: number | null; stored?: boolean } = {},
): Promise<Arranged> {
  const org = randomUUID();
  const user = randomUUID();
  const session = randomUUID();
  await sql("INSERT INTO auth.organization (id, name, slug) VALUES ($1, 'Org', $2)", [org, org]);
  await sql(`INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`, [
    user,
    `${user}@test.dev`,
  ]);
  // The member records in their own workspace (the trigger that deletes an attempt's take
  // checks it's a member's of the attempt's workspace).
  await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [
    org,
    user,
  ]);
  const [plan] = await sql<{ id: string }>(
    `INSERT INTO ai.director_plan (org_id, video_id, source, status, stage, updated_at)
     VALUES ($1, 'dQw4w9WgXcQ', 'seed', 'ready', 'ready', now()) RETURNING id`,
    [org],
  );
  await sql(
    `INSERT INTO app.recording_session (id, org_id, user_id, plan_id, video_id, shot_count, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, 'dQw4w9WgXcQ', 3, now() + interval '7 days', now())`,
    [session, org, user, plan?.id],
  );
  await sql(
    `INSERT INTO app.recording_part (session_id, org_id, index, camera, content_type, slice_count)
     VALUES ($1, $2, 0, 'front', 'video/webm', $3)`,
    [session, org, sliceCount],
  );
  for (let index = 0; index < slices; index++) {
    await sql(
      `INSERT INTO app.recording_slice (session_id, org_id, part_index, index, start_ms, duration_ms, size, status)
       VALUES ($1, $2, 0, $3, $4, 10000, 7, 'uploaded')`,
      [session, org, index, index * 10_000],
    );
    if (stored) {
      await storage.write(
        `recordings/${session}/0/${index}`,
        Buffer.from(`slice-${index}`),
        "video/webm",
      );
    }
  }
  return { org, user, session };
}

/** An attempt of the session, between Director's marks, waiting for the clipper. */
async function attemptOf(
  { org, session }: Arranged,
  startMs: number,
  endMs: number | null,
  number = 1,
) {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO app.recording_attempt (org_id, session_id, number, shot_index, part_index, start_ms, end_ms, status, updated_at)
     VALUES ($1, $2, $3, 1, 0, $4, $5, 'clipping', now()) RETURNING id`,
    [org, session, number, startMs, endMs],
  );
  return recordingAttemptIdSchema.parse(row?.id);
}

async function attemptRow(id: string) {
  const [row] = await sql<{
    status: string;
    error: string | null;
    clip_start_ms: number | null;
    clip_end_ms: number | null;
    file_id: string | null;
    take_id: string | null;
  }>(
    "SELECT status, error, clip_start_ms, clip_end_ms, file_id, take_id FROM app.recording_attempt WHERE id = $1",
    [id],
  );
  return row;
}

describe("cutting an attempt into a take", { tags: ["files"] }, () => {
  it("sends the footage it needs, stores the take and records it", async () => {
    const arranged = await recorded(4);
    const attempt = await attemptOf(arranged, 12_000, 17_000);
    await clipper.clip(orgIdSchema.parse(arranged.org), attempt);

    // Up to two seconds past the end mark (for snapping), from the first: two slices.
    const [request] = clipRequests;
    expect(request?.slices).toEqual(["slice-0", "slice-1"]);
    expect(request?.body).toMatchObject({
      attemptId: attempt,
      contentType: "video/webm",
      startMs: 12_000,
      endMs: 17_000,
      pauses: [],
    });
    const row = await attemptRow(attempt);
    expect(row).toMatchObject({
      status: "clipped",
      error: null,
      clip_start_ms: 11_750,
      clip_end_ms: 17_250,
    });
    const [file] = await sql<{
      status: string;
      purpose: string;
      size: number;
      user_id: string;
      filename: string;
    }>("SELECT status, purpose, size, user_id, filename FROM files.file WHERE id = $1", [
      row?.file_id,
    ]);
    expect(file).toEqual({
      status: "ready",
      purpose: "director-take-video",
      size: MP4.length,
      user_id: arranged.user,
      filename: "attempt-1.mp4",
    });
    expect((await storage.read(`files/${row?.file_id}`, 1_000)).equals(MP4)).toBe(true);
    const [take] = takeRequests;
    expect(take?.body).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      shotIndex: 1,
      kind: "video",
      fileId: row?.file_id,
      contentType: "video/mp4",
    });
    expect(take?.take.equals(MP4)).toBe(true);
    expect(take?.user).toBe(arranged.user);
    const [recordedTake] = await sql<{ id: string }>(
      "SELECT id FROM ai.director_take WHERE file_id = $1",
      [row?.file_id],
    );
    expect(row?.take_id).toBe(recordedTake?.id);

    // Done: a second run changes nothing.
    await clipper.clip(orgIdSchema.parse(arranged.org), attempt);
    expect(clipRequests).toHaveLength(1);
  });

  it("cuts an attempt open at its part's end from all of the part's footage, and its pauses", async () => {
    const arranged = await recorded(2, { sliceCount: 2 });
    await sql(
      "INSERT INTO app.recording_pause (session_id, org_id, part_index, start_ms, end_ms) VALUES ($1, $2, 0, 3000, 3000)",
      [arranged.session, arranged.org],
    );
    const attempt = await attemptOf(arranged, 4_000, null);
    await clipper.clip(orgIdSchema.parse(arranged.org), attempt);
    expect(clipRequests[0]?.slices).toEqual(["slice-0", "slice-1"]);
    expect(clipRequests[0]?.body).toMatchObject({
      endMs: null,
      pauses: [{ startMs: 3_000, endMs: 3_000 }],
    });
    expect((await attemptRow(attempt))?.status).toBe("clipped");
  });

  it("retries a clipper outage, and fails the attempt once its tries are spent", async () => {
    const arranged = await recorded(2);
    const attempt = await attemptOf(arranged, 1_000, 5_000);
    const org = orgIdSchema.parse(arranged.org);
    mode.clip = "down";
    await expect(clipper.clip(org, attempt, false)).rejects.toThrow();
    expect(await attemptRow(attempt)).toMatchObject({ status: "clipping", file_id: null });
    await expect(clipper.clip(org, attempt, true)).rejects.toThrow();
    expect(await attemptRow(attempt)).toMatchObject({
      status: "failed",
      error: "RECORDING_CLIP_FAILED",
    });
  });

  it("fails an attempt the clipper can't cut, or the AI service won't take, at once", async () => {
    const arranged = await recorded(2);
    const org = orgIdSchema.parse(arranged.org);
    const uncut = await attemptOf(arranged, 1_000, 5_000);
    mode.clip = "refuse";
    await clipper.clip(org, uncut, false);
    expect(await attemptRow(uncut)).toMatchObject({
      status: "failed",
      error: "RECORDING_CLIP_FAILED",
    });

    mode.clip = "ok";
    mode.take = "kind";
    const photo = await attemptOf(arranged, 6_000, 8_000, 2);
    await clipper.clip(org, photo, false);
    expect(await attemptRow(photo)).toMatchObject({
      status: "failed",
      error: "DIRECTOR_TAKE_KIND_MISMATCH",
    });
  });

  it("keeps the take's file across a retry", async () => {
    const arranged = await recorded(2);
    const org = orgIdSchema.parse(arranged.org);
    const attempt = await attemptOf(arranged, 1_000, 5_000);
    mode.take = "down";
    await expect(clipper.clip(org, attempt, false)).rejects.toThrow();
    const kept = (await attemptRow(attempt))?.file_id;
    expect(kept).toBeTruthy();
    mode.take = "ok";
    await clipper.clip(org, attempt, false);
    expect(await attemptRow(attempt)).toMatchObject({ status: "clipped", file_id: kept });
    expect(await sql("SELECT id FROM files.file WHERE user_id = $1", [arranged.user])).toHaveLength(
      1,
    );
  });

  it("waits for footage still to come, and fails a part that ended with none", async () => {
    const waiting = await recorded(1);
    const later = await attemptOf(waiting, 1_000, 30_000);
    await expect(clipper.clip(orgIdSchema.parse(waiting.org), later, false)).rejects.toThrow(
      /isn't all stored yet/,
    );
    expect((await attemptRow(later))?.status).toBe("clipping");

    const empty = await recorded(0, { sliceCount: 0 });
    const nothing = await attemptOf(empty, 0, null);
    await clipper.clip(orgIdSchema.parse(empty.org), nothing, false);
    expect(await attemptRow(nothing)).toMatchObject({
      status: "failed",
      error: "RECORDING_CLIP_FAILED",
    });
    expect(clipRequests).toEqual([]);
  });

  it("does nothing for an attempt that's gone", async () => {
    const arranged = await recorded(1);
    await clipper.clip(
      orgIdSchema.parse(arranged.org),
      recordingAttemptIdSchema.parse(randomUUID()),
    );
    expect(clipRequests).toEqual([]);
  });

  it("leaves nothing of a session deleted while its attempt was cut", async () => {
    const arranged = await recorded(2);
    const org = orgIdSchema.parse(arranged.org);
    const filesOf = () => sql("SELECT id FROM files.file WHERE user_id = $1", [arranged.user]);

    // Deleted before the take's file was made: none is.
    mode.clip = "delete";
    await clipper.clip(org, await attemptOf(arranged, 1_000, 5_000), false);
    expect(await filesOf()).toEqual([]);
    expect(takeRequests).toEqual([]);
  });

  it("deletes a take's bytes stored after its session was deleted", async () => {
    const arranged = await recorded(2);
    const attempt = await attemptOf(arranged, 1_000, 5_000);
    // The member deletes the session while the take's bytes are on their way to storage:
    // its file (and the object's deletion) went before the object existed.
    const workerStorage = app.get<Storage>(STORAGE);
    const write = workerStorage.write.bind(workerStorage);
    const stored: string[] = [];
    const slowWrite = vi
      .spyOn(workerStorage, "write")
      .mockImplementationOnce(async (key, body, contentType) => {
        await deleteSessionOf(attempt);
        stored.push(key);
        return write(key, body, contentType);
      });
    await clipper.clip(orgIdSchema.parse(arranged.org), attempt, false);
    slowWrite.mockRestore();
    expect(stored).toHaveLength(1);
    expect(await storage.head(stored[0] as string)).toBeNull();
    expect(await sql("SELECT id FROM files.file WHERE user_id = $1", [arranged.user])).toEqual([]);
    expect(takeRequests).toEqual([]);
  });

  it("makes no take of a session deleted while the take was made", async () => {
    const before = await recorded(2);
    const org = orgIdSchema.parse(before.org);
    // Deleted just before apps/ai records the take: it can't, and the retry finds nothing.
    mode.take = "delete";
    const attempt = await attemptOf(before, 1_000, 5_000);
    await expect(clipper.clip(org, attempt, false)).rejects.toThrow();
    expect(await attemptRow(attempt)).toBeUndefined();
    await clipper.clip(org, attempt, false);
    expect(await sql("SELECT id FROM files.file WHERE user_id = $1", [before.user])).toEqual([]);

    // Deleted just after: the take went with its file.
    const after = await recorded(2);
    mode.take = "deleteAfter";
    await clipper.clip(orgIdSchema.parse(after.org), await attemptOf(after, 1_000, 5_000), false);
    expect(await sql("SELECT id FROM files.file WHERE user_id = $1", [after.user])).toEqual([]);
    expect(await sql("SELECT id FROM ai.director_take WHERE user_id = $1", [after.user])).toEqual(
      [],
    );
  });

  it("uses the file another run of the attempt made first", async () => {
    const arranged = await recorded(2);
    const attempt = await attemptOf(arranged, 1_000, 5_000);
    mode.clip = "claim";
    await clipper.clip(orgIdSchema.parse(arranged.org), attempt, false);
    const files = await sql<{ id: string; status: string }>(
      "SELECT id, status FROM files.file WHERE user_id = $1",
      [arranged.user],
    );
    expect(files).toEqual([{ id: (await attemptRow(attempt))?.file_id, status: "ready" }]);
    expect((await attemptRow(attempt))?.status).toBe("clipped");
  });

  it("cuts an attempt queued on the recording queue", async () => {
    const arranged = await recorded(2);
    const attempt = await attemptOf(arranged, 1_000, 5_000);
    const queue = new Queue("recording", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("recording"),
    });
    await queue.add(
      "clip",
      { meta: {}, payload: { attemptId: attempt, orgId: arranged.org } },
      { jobId: attempt },
    );
    await eventually(
      () => attemptRow(attempt),
      (row) => row?.status === "clipped",
    );
    await queue.close();
  });
});

describe("recording retention", () => {
  it("deletes footage past its keeping, the demo's takes with it, and queues its objects", async () => {
    const kept = await recorded(1, { stored: false });
    const expired = await recorded(1, { stored: false });
    const demo = await recorded(1, { stored: false });
    const [file] = await sql<{ id: string }>(
      `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
       VALUES ($1, 'director-take-video', 'ready', 'attempt-1.mp4', 'video/mp4', 10, now()) RETURNING id`,
      [demo.user],
    );
    const demoAttempt = await attemptOf(demo, 0, 1_000);
    await sql("UPDATE app.recording_attempt SET file_id = $1 WHERE id = $2", [
      file?.id,
      demoAttempt,
    ]);
    await sql(
      "UPDATE app.recording_session SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)",
      [[expired.session, demo.session]],
    );
    await sql("UPDATE app.recording_session SET demo = true WHERE id = $1", [demo.session]);

    const result = await maintenance.run("recording-retention");
    expect(result.expired).toBeGreaterThanOrEqual(2);
    const left = await sql<{ id: string }>(
      "SELECT id FROM app.recording_session WHERE id = ANY($1)",
      [[kept.session, expired.session, demo.session]],
    );
    expect(left.map((row) => row.id)).toEqual([kept.session]);
    expect(await sql("SELECT id FROM files.file WHERE id = $1", [file?.id])).toEqual([]);
    const queued = await sql<{ key: string }>(
      "SELECT key FROM files.object_deletion WHERE key = ANY($1)",
      [
        [
          `recordings/${expired.session}/0/0`,
          `recordings/${demo.session}/0/0`,
          `files/${file?.id}`,
        ],
      ],
    );
    expect(queued).toHaveLength(3);
  });

  it("finishes a session left open and queues its attempts for the clipper", async () => {
    const open = await recorded(3, { stored: false });
    // The third slice was signed but never stored: the part has the first two.
    await sql(
      "UPDATE app.recording_slice SET status = 'pending' WHERE session_id = $1 AND index = 2",
      [open.session],
    );
    const attempt = await attemptOf(open, 5_000, null);
    await sql("UPDATE app.recording_attempt SET status = 'open' WHERE id = $1", [attempt]);
    const active = await recorded(1, { stored: false });
    await sql(
      "UPDATE app.recording_session SET updated_at = now() - interval '7 hours' WHERE id = $1",
      [open.session],
    );

    const queue = new Queue("recording", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("recording"),
    });
    await queue.pause();
    const result = await maintenance.run("recording-retention");
    expect(result.finished).toBe(1);
    const [session] = await sql<{ status: string }>(
      "SELECT status FROM app.recording_session WHERE id = $1",
      [open.session],
    );
    expect(session?.status).toBe("done");
    expect(
      await sql("SELECT slice_count FROM app.recording_part WHERE session_id = $1", [open.session]),
    ).toEqual([{ slice_count: 2 }]);
    expect((await attemptRow(attempt))?.status).toBe("waiting");
    const job = await queue.getJob(attempt);
    expect(job?.data).toEqual({
      meta: { orgId: open.org },
      payload: { attemptId: attempt, orgId: open.org },
    });
    // The queue's own retries, backoff and clean-up (packages/jobs), as apps/api's jobs.
    expect(job?.opts).toMatchObject({
      attempts: queues.recording.options.attempts,
      backoff: queues.recording.options.backoff,
      removeOnComplete: queues.recording.options.removeOnComplete,
      removeOnFail: queues.recording.options.removeOnFail,
    });
    const [still] = await sql<{ status: string }>(
      "SELECT status FROM app.recording_session WHERE id = $1",
      [active.session],
    );
    expect(still?.status).toBe("recording");
    await queue.obliterate({ force: true });
    await queue.resume();
    await queue.close();
  });

  it("finishes a session Done with its footage still to come, once it has stopped coming", async () => {
    const queue = new Queue("recording", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("recording"),
    });
    await queue.pause();
    // Done, with a part whose recorder never said how many slices it made...
    const unclosed = await recorded(2, { stored: false });
    // ...and Done with a slice that never arrived between two that did.
    const gap = await recorded(3, { sliceCount: 3, stored: false });
    await sql(
      "UPDATE app.recording_slice SET status = 'pending' WHERE session_id = $1 AND index = 1",
      [gap.session],
    );
    const waiting = [await attemptOf(unclosed, 1_000, null), await attemptOf(gap, 25_000, 28_000)];
    await sql("UPDATE app.recording_attempt SET status = 'waiting' WHERE id = ANY($1)", [waiting]);
    const sessions = [unclosed.session, gap.session];
    await sql("UPDATE app.recording_session SET status = 'done' WHERE id = ANY($1)", [sessions]);

    // Within the grace period, they're left to finish on their own.
    await maintenance.run("recording-retention");
    expect(await queue.getJob(waiting[0] as string)).toBeUndefined();

    await sql(
      "UPDATE app.recording_session SET updated_at = now() - interval '7 hours' WHERE id = ANY($1)",
      [sessions],
    );
    const result = await maintenance.run("recording-retention");
    expect(result.finished).toBeGreaterThanOrEqual(2);
    const parts = await sql<{ session_id: string; slice_count: number }>(
      "SELECT session_id, slice_count FROM app.recording_part WHERE session_id = ANY($1)",
      [sessions],
    );
    // Each keeps what was stored from its first slice without a gap.
    expect(Object.fromEntries(parts.map((part) => [part.session_id, part.slice_count]))).toEqual({
      [unclosed.session]: 2,
      [gap.session]: 1,
    });
    for (const id of waiting) {
      expect((await queue.getJob(id))?.data.payload.attemptId).toBe(id);
    }
    await queue.obliterate({ force: true });
    await queue.resume();
    await queue.close();
  });
});
