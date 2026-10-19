/**
 * Director's continuous recording through the API: sessions, parts, marks, pauses, Done,
 * slices signed and stored, and the attempts queued for the clipper, against the real
 * database (as app_api, under row-level security), a stand-in for the AI service (which
 * answers each workspace's real seeded plans) and, for the slices, the local object
 * storage.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { directorSeeds } from "@repo/contracts/director-seeds";
import {
  directorTakeIdSchema,
  orgIdSchema,
  type RecordingSessionId,
  userIdSchema,
} from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { HOUR_MS } from "@repo/contracts/time";
import { parseJob, queuePrefix } from "@repo/jobs";
import { Queue } from "bullmq";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_EMAIL } from "../src/auth/demo";
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
/** A seeded template every workspace has, with its real plan. */
const SEED = required(directorSeeds[0], "a committed seed");
const SHOTS = SEED.plan.shots.length;
/** A short no workspace has. */
const UNKNOWN = "Unknown0001";

let harness: Harness;
let ai: Server;
let queue: Queue;

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
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

/** The AI service's plan read, from the workspace's real plans (its seeded templates). */
async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    issuer: "api",
    audience: "ai",
  });
  const match = /^\/v1\/director\/plans\/([\w-]{11})$/.exec(request.url ?? "");
  const fail = (status: number, code: string) =>
    send(response, status, { defined: true, code, status, message: code, data: { params: {} } });
  if (request.method !== "GET" || !match) {
    return fail(404, "NOT_FOUND");
  }
  const [plan] = await sql<{ id: string; status: string; plan: unknown }>(
    "SELECT id, status, plan FROM ai.director_plan WHERE org_id = $1 AND video_id = $2",
    [String(payload.org), match[1]],
  );
  if (!plan) {
    return fail(404, "DIRECTOR_PLAN_NOT_FOUND");
  }
  const now = new Date().toISOString();
  return send(response, 200, {
    id: plan.id,
    videoId: match[1],
    source: "seed",
    status: plan.status,
    stage: plan.status === "ready" ? "ready" : "queued",
    error: null,
    plan: plan.status === "ready" ? plan.plan : null,
    model: null,
    audioStatus: "none",
    audioKey: null,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  ai = createServer((request, response) => void aiRoute(request, response));
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  harness = await startApi(23, {
    ...LOCAL_STORAGE,
    YOUTUBE_API_KEY: "test-youtube-key",
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
  });
  queue = new Queue("recording", {
    connection: harness.redis.duplicate(),
    prefix: queuePrefix("recording"),
  });
});

afterAll(async () => {
  await queue?.close();
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  const password = newPassword();
  await session.auth("/sign-up/email", { email, password, name: "Filmer" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  const me = await session.rpc.user.me();
  const [member] = await sql<{ org: string }>(
    "SELECT organization_id AS org FROM auth.member WHERE user_id = $1",
    [me.id],
  );
  return { session, me, email, password, org: required(member, "a workspace").org };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

/** A member recording the seed, with its first part started. */
async function recording() {
  const member = await signedIn();
  const rpc = member.session.rpc.recording;
  const started = await rpc.start({ videoId: SEED.videoId });
  const sessionId = started.id;
  await rpc.addPart({ sessionId, index: 0, camera: "front", contentType: "video/webm" });
  return { ...member, rpc, sessionId, started };
}

type Rpc = Awaited<ReturnType<typeof recording>>["rpc"];

/** Director's mark for attempt `attempt`, in part 0 unless it says. */
function mark(
  rpc: Rpc,
  sessionId: RecordingSessionId,
  event: "start" | "end",
  attempt: number,
  atMs: number,
  extra: { shotIndex?: number; partIndex?: number; line?: string; note?: string } = {},
) {
  return rpc.mark({ sessionId, event, attempt, atMs, shotIndex: 0, partIndex: 0, ...extra });
}

/** Slices as the shoot screen sends them: ten seconds each, from the part's start. */
const slice = (sessionId: RecordingSessionId, partIndex: number, index: number, size = 1_000) => ({
  sessionId,
  partIndex,
  index,
  startMs: index * 10_000,
  durationMs: 10_000,
  size,
});

/** The clip job queued for an attempt, if there is one. */
async function clipJob(attemptId: string) {
  const job = await queue.getJob(attemptId);
  return job ? parseJob("recording", "clip", job.data).payload : undefined;
}

describe("starting a session", () => {
  it("records a ready plan, its footage kept a week", async () => {
    const { started } = await recording();
    expect(started).toMatchObject({
      videoId: SEED.videoId,
      status: "recording",
      paused: false,
      recordedMs: 0,
      bytes: 0,
      finishedAt: null,
      parts: [],
      attempts: [],
    });
    const kept = started.expiresAt.getTime() - started.createdAt.getTime();
    expect(Math.round(kept / HOUR_MS)).toBe(7 * 24);
  });

  it("carries on the member's open session of the short, not a second one, until it's done", async () => {
    // A closed tab or a crash left it recording: back on the shoot screen, it goes on.
    const { rpc, sessionId } = await recording();
    await mark(rpc, sessionId, "start", 1, 1_000);
    const again = await rpc.start({ videoId: SEED.videoId });
    expect(again.id).toBe(sessionId);
    expect(again.parts.map((part) => part.index)).toEqual([0]);
    expect(again.attempts.map((attempt) => attempt.number)).toEqual([1]);
    // Done: the next start is a new session.
    await rpc.finish({ sessionId });
    const next = await rpc.start({ videoId: SEED.videoId });
    expect(next.id).not.toBe(sessionId);
    expect(next.parts).toEqual([]);
  });

  it("keeps a demo guest's footage a day", async () => {
    const { me, email, password } = await signedIn();
    await sql('UPDATE auth."user" SET demo = true WHERE id = $1', [me.id]);
    const guest = createSession(harness);
    await guest.auth("/sign-in/email", { email, password });
    const started = await guest.rpc.recording.start({ videoId: SEED.videoId });
    const kept = started.expiresAt.getTime() - started.createdAt.getTime();
    expect(Math.round(kept / HOUR_MS)).toBe(24);
  });

  it("refuses the shared demo account, where everyone would see everyone's footage", async () => {
    const { me, password } = await signedIn();
    await sql('UPDATE auth."user" SET demo = true, email = $2 WHERE id = $1', [me.id, DEMO_EMAIL]);
    const shared = createSession(harness);
    await shared.auth("/sign-in/email", { email: DEMO_EMAIL, password });
    await expectError(shared.rpc.recording.start({ videoId: SEED.videoId }), "DEMO_ACCOUNT_LOCKED");
  });

  it("refuses a short that isn't in the library or isn't ready", async () => {
    const { session, org } = await signedIn();
    await expectError(session.rpc.recording.start({ videoId: UNKNOWN }), "DIRECTOR_PLAN_NOT_FOUND");
    await sql("UPDATE ai.director_plan SET status = 'analyzing' WHERE org_id = $1", [org]);
    await expectError(
      session.rpc.recording.start({ videoId: SEED.videoId }),
      "DIRECTOR_PLAN_NOT_READY",
    );
  });
});

/**
 * Fills the member's footage allowance up to `bytes`, in an earlier session of theirs (so
 * the session under test keeps its own 20 minutes). It's written here, finished: starting
 * the same short again would carry on the session under test.
 */
async function footageElsewhere(sessionId: RecordingSessionId, bytes: number) {
  const [other] = await sql<{ id: string }>(
    `INSERT INTO app.recording_session
       (org_id, user_id, plan_id, video_id, shot_count, demo, status, finished_at, expires_at, updated_at)
     SELECT org_id, user_id, plan_id, video_id, shot_count, demo, 'done', now(), expires_at, now()
       FROM app.recording_session WHERE id = $1
     RETURNING id::text`,
    [sessionId],
  );
  const id = required(other, "the earlier session").id;
  await sql(
    `INSERT INTO app.recording_part (session_id, org_id, index, camera, content_type)
     SELECT id, org_id, 0, 'front', 'video/webm' FROM app.recording_session WHERE id = $1`,
    [id],
  );
  await sql(
    `INSERT INTO app.recording_slice (session_id, org_id, part_index, index, start_ms, duration_ms, size)
     SELECT id, org_id, 0, 0, 0, 10000, $2 FROM app.recording_session WHERE id = $1`,
    [id, bytes],
  );
  return id;
}

describe("the limits", () => {
  it("refuses once the member's footage is at its allowance, and past 20 minutes", async () => {
    const { rpc, sessionId, session } = await recording();
    const elsewhere = await footageElsewhere(sessionId, 999_999_000);
    await expectError(rpc.uploadSlice(slice(sessionId, 0, 0, 2_000)), "RECORDING_STORAGE_FULL");
    await sql("UPDATE app.recording_slice SET size = 10 WHERE session_id = $1", [elsewhere]);
    await sql(
      `INSERT INTO app.recording_slice (session_id, org_id, part_index, index, start_ms, duration_ms, size)
       SELECT id, org_id, 0, 0, 0, 1210000, 10 FROM app.recording_session WHERE id = $1`,
      [sessionId],
    );
    await expectError(rpc.uploadSlice(slice(sessionId, 0, 1)), "RECORDING_LIMIT_REACHED");
    await sql("UPDATE app.recording_slice SET size = 1000000000 WHERE session_id = $1", [
      elsewhere,
    ]);
    await expectError(
      session.rpc.recording.start({ videoId: SEED.videoId }),
      "RECORDING_STORAGE_FULL",
    );
  });

  it("counts a slice by its size when it claims to be shorter than its bytes allow", async () => {
    const { rpc, sessionId } = await recording();
    // 20 minutes and 6 seconds counted so far: room for 9 more seconds.
    await sql(
      `INSERT INTO app.recording_slice (session_id, org_id, part_index, index, start_ms, duration_ms, size)
       SELECT id, org_id, 0, 0, 0, 1206000, 10 FROM app.recording_session WHERE id = $1`,
      [sessionId],
    );
    // Eight megabytes said to last a millisecond count as the ten seconds they take at
    // the highest bitrate a recorder reaches: more than the 9 seconds left.
    await expectError(
      rpc.uploadSlice({ ...slice(sessionId, 0, 1, 8_000_000), durationMs: 1 }),
      "RECORDING_LIMIT_REACHED",
    );
    expect(
      (await rpc.uploadSlice({ ...slice(sessionId, 0, 1, 1_000), durationMs: 1 })).upload,
    ).not.toBeNull();
  });

  it("fits only as many uploads at once as the allowance holds", async () => {
    const { rpc, sessionId, me } = await recording();
    // Room for four more 8 MB slices.
    await footageElsewhere(sessionId, 1_000_000_000 - 4 * 8_000_000);
    const racing = await Promise.allSettled(
      Array.from({ length: 10 }, (_, n) => rpc.uploadSlice(slice(sessionId, 0, n, 8_000_000))),
    );
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    const [stored] = await sql<{ bytes: string }>(
      `SELECT sum(sl.size)::text AS bytes FROM app.recording_slice sl
         JOIN app.recording_session s ON s.id = sl.session_id WHERE s.user_id = $1`,
      [me.id],
    );
    expect(Number(stored?.bytes)).toBeLessThanOrEqual(1_000_000_000);
  });
});

describe("a session's parts and marks", () => {
  it("adds a part once, and refuses the same index for another camera", async () => {
    const { rpc, sessionId } = await recording();
    const again = await rpc.addPart({
      sessionId,
      index: 0,
      camera: "front",
      contentType: "video/webm",
    });
    expect(again).toEqual({
      index: 0,
      camera: "front",
      contentType: "video/webm",
      sliceCount: null,
      uploaded: [],
    });
    await expectError(
      rpc.addPart({ sessionId, index: 0, camera: "back", contentType: "video/webm" }),
      "RECORDING_PART_CLOSED",
    );
  });

  it("takes each attempt's number from the screen, and ends the open one at the next start", async () => {
    const { rpc, sessionId } = await recording();
    const first = await mark(rpc, sessionId, "start", 1, 1_000, { line: "Hi!" });
    expect(first).toMatchObject({ number: 1, status: "open", startMs: 1_000, endMs: null });
    expect(await mark(rpc, sessionId, "start", 1, 1_000)).toMatchObject({ id: first.id });

    const second = await mark(rpc, sessionId, "start", 2, 5_000);
    expect(second).toMatchObject({ number: 2, status: "open" });
    const ended = await mark(rpc, sessionId, "end", 2, 9_000, { note: "Clean, a little fast" });
    expect(ended).toMatchObject({
      id: second.id,
      status: "waiting",
      endMs: 9_000,
      note: "Clean, a little fast",
    });
    expect(await mark(rpc, sessionId, "end", 2, 9_000)).toMatchObject({ id: second.id });
    await expectError(mark(rpc, sessionId, "end", 3, 12_000), "RECORDING_ATTEMPT_NOT_OPEN");
    await expectError(
      mark(rpc, sessionId, "start", 3, 13_000, { shotIndex: SHOTS }),
      "DIRECTOR_SHOT_NOT_FOUND",
    );

    const { attempts } = await rpc.session({ sessionId });
    expect(attempts.map((attempt) => [attempt.number, attempt.status, attempt.endMs])).toEqual([
      [1, "waiting", 5_000],
      [2, "waiting", 9_000],
    ]);
  });

  it("never lets an end sent again end a newer attempt", async () => {
    const { rpc, sessionId } = await recording();
    await mark(rpc, sessionId, "start", 1, 1_000);
    const ended = await mark(rpc, sessionId, "end", 1, 20_000);
    const newer = await mark(rpc, sessionId, "start", 2, 25_000);
    // The first end's answer was lost, and it's sent again after the next start.
    expect(await mark(rpc, sessionId, "end", 1, 20_000)).toEqual(ended);
    const { attempts } = await rpc.session({ sessionId });
    expect(attempts.find((attempt) => attempt.id === newer.id)).toMatchObject({
      status: "open",
      endMs: null,
    });
    // Numbers may skip (a start that never arrived), but never go back: a start from
    // before the screen was reloaded, numbered below the last, is refused.
    await mark(rpc, sessionId, "start", 4, 30_000);
    await expectError(mark(rpc, sessionId, "start", 3, 35_000), "RECORDING_MARK_OUT_OF_ORDER");
    // One attempt per start in a part: a second start at the same moment is refused too.
    await expectError(mark(rpc, sessionId, "start", 5, 30_000), "RECORDING_MARK_OUT_OF_ORDER");
    expect(await mark(rpc, sessionId, "start", 5, 31_000)).toMatchObject({ number: 5 });
  });

  it("ends an attempt at a pause, refuses marks while paused, and takes them after a touch", async () => {
    const { rpc, sessionId } = await recording();
    const attempt = await mark(rpc, sessionId, "start", 1, 0);
    const paused = await rpc.pause({ sessionId, partIndex: 0, atMs: 4_000 });
    expect(paused.paused).toBe(true);
    expect(await rpc.pause({ sessionId, partIndex: 0, atMs: 4_500 })).toMatchObject({
      paused: true,
    });
    await expectError(mark(rpc, sessionId, "start", 2, 5_000), "RECORDING_PAUSED");
    const resumed = await rpc.resume({ sessionId, partIndex: 0, atMs: 4_000 });
    expect(resumed.paused).toBe(false);
    expect(await rpc.resume({ sessionId, partIndex: 0, atMs: 4_000 })).toMatchObject({
      paused: false,
    });
    await mark(rpc, sessionId, "start", 2, 6_000, { shotIndex: 1 });

    const { attempts } = await rpc.session({ sessionId });
    expect(attempts[0]).toMatchObject({ id: attempt.id, status: "waiting", endMs: 4_000 });
    const pauses = await sql(
      "SELECT start_ms, end_ms FROM app.recording_pause WHERE session_id = $1",
      [sessionId],
    );
    expect(pauses).toEqual([{ start_ms: 4_000, end_ms: 4_000 }]);
  });

  it("lets a pause run to its part's end when the recorder starts again", async () => {
    const { rpc, sessionId } = await recording();
    await mark(rpc, sessionId, "start", 1, 2_000);
    await rpc.pause({ sessionId, partIndex: 0, atMs: 8_000 });
    await rpc.closePart({ sessionId, index: 0, sliceCount: 0 });
    await rpc.addPart({ sessionId, index: 1, camera: "back", contentType: "video/mp4" });
    await rpc.resume({ sessionId, partIndex: 1, atMs: 0 });
    await expectError(mark(rpc, sessionId, "start", 2, 9_000), "RECORDING_PART_CLOSED");
    const next = await mark(rpc, sessionId, "start", 2, 1, { partIndex: 1 });
    expect(next.number).toBe(2);
    const pauses = await sql("SELECT end_ms FROM app.recording_pause WHERE session_id = $1", [
      sessionId,
    ]);
    expect(pauses).toEqual([{ end_ms: null }]);
  });

  it("ends an attempt open in an earlier part at that part's end", async () => {
    const { rpc, sessionId } = await recording();
    await mark(rpc, sessionId, "start", 1, 2_000);
    await rpc.addPart({ sessionId, index: 1, camera: "back", contentType: "video/webm" });
    // A start in the new part ends it there too.
    const ended = await mark(rpc, sessionId, "end", 1, 500, { partIndex: 1 });
    expect(ended).toMatchObject({ status: "waiting", endMs: null });
  });

  it("finishes once: an open attempt runs to its part's end, and nothing more records", async () => {
    const { rpc, sessionId } = await recording();
    await mark(rpc, sessionId, "start", 1, 2_000);
    await rpc.pause({ sessionId, partIndex: 0, atMs: 3_000 });
    await rpc.resume({ sessionId, partIndex: 0, atMs: 3_000 });
    await mark(rpc, sessionId, "start", 2, 4_000);
    await rpc.pause({ sessionId, partIndex: 0, atMs: 6_000 });
    const [done, alsoDone] = await Promise.all([
      rpc.finish({ sessionId }),
      rpc.finish({ sessionId }),
    ]);
    expect(done).toMatchObject({ status: "done", paused: false });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(alsoDone.finishedAt).toEqual(done.finishedAt);
    expect((await rpc.finish({ sessionId })).finishedAt).toEqual(done.finishedAt);

    await expectError(mark(rpc, sessionId, "start", 3, 7_000), "RECORDING_FINISHED");
    await expectError(rpc.pause({ sessionId, partIndex: 0, atMs: 7_000 }), "RECORDING_FINISHED");
    await expectError(rpc.resume({ sessionId, partIndex: 0, atMs: 7_000 }), "RECORDING_FINISHED");
    await expectError(
      rpc.addPart({ sessionId, index: 1, camera: "front", contentType: "video/webm" }),
      "RECORDING_FINISHED",
    );
    // A queue left behind still uploads.
    expect((await rpc.uploadSlice(slice(sessionId, 0, 0))).upload).not.toBeNull();
  });

  it("queues the post-session pass once Done, and again if it wasn't the first time", async () => {
    const director = new Queue("ai-director", {
      connection: harness.redis.duplicate(),
      prefix: queuePrefix("ai-director"),
    });
    try {
      const { rpc, sessionId, org } = await recording();
      await rpc.finish({ sessionId });
      expect((await director.getJob(sessionId))?.data.payload).toEqual({ sessionId, orgId: org });
      const [stamped] = await sql<{ queued: Date | null }>(
        "SELECT pass_queued_at AS queued FROM app.recording_session WHERE id = $1",
        [sessionId],
      );
      expect(stamped?.queued).toBeInstanceOf(Date);

      // Done, but its pass never made it onto the queue (Redis failed after the commit):
      // Done again queues it, though it changes nothing else.
      const lost = await recording();
      await lost.rpc.finish({ sessionId: lost.sessionId });
      await director.remove(lost.sessionId);
      await sql("UPDATE app.recording_session SET pass_queued_at = NULL WHERE id = $1", [
        lost.sessionId,
      ]);
      await lost.rpc.finish({ sessionId: lost.sessionId });
      expect((await director.getJob(lost.sessionId))?.data.payload.sessionId).toBe(lost.sessionId);
    } finally {
      await director.close();
    }
  });

  it("pauses and finishes a session with no attempt open in it", async () => {
    const { rpc, sessionId } = await recording();
    expect((await rpc.pause({ sessionId, partIndex: 0, atMs: 1_000 })).paused).toBe(true);
    await rpc.resume({ sessionId, partIndex: 0, atMs: 1_000 });
    expect((await rpc.finish({ sessionId })).status).toBe("done");
    expect((await rpc.session({ sessionId })).attempts).toEqual([]);
  });

  it("refuses a part that doesn't exist, or a slice past an ended part", async () => {
    const { rpc, sessionId } = await recording();
    await expectError(
      mark(rpc, sessionId, "start", 1, 0, { partIndex: 3 }),
      "RECORDING_PART_NOT_FOUND",
    );
    await expectError(rpc.uploadSlice(slice(sessionId, 3, 0)), "RECORDING_PART_NOT_FOUND");
    await rpc.uploadSlice(slice(sessionId, 0, 0));
    await rpc.uploadSlice(slice(sessionId, 0, 1));
    await expectError(
      rpc.closePart({ sessionId, index: 0, sliceCount: 1 }),
      "RECORDING_PART_CLOSED",
    );
    const closed = await rpc.closePart({ sessionId, index: 0, sliceCount: 2 });
    expect(closed.sliceCount).toBe(2);
    expect((await rpc.closePart({ sessionId, index: 0, sliceCount: 2 })).sliceCount).toBe(2);
    await expectError(
      rpc.closePart({ sessionId, index: 0, sliceCount: 3 }),
      "RECORDING_PART_CLOSED",
    );
    await expectError(rpc.uploadSlice(slice(sessionId, 0, 2)), "RECORDING_PART_CLOSED");
    await expectError(
      rpc.completeSlice({ sessionId, partIndex: 0, index: 5 }),
      "RECORDING_SLICE_NOT_UPLOADED",
    );
  });
});

describe("whose sessions they are", () => {
  it("lists the member's own, and no one else may read or change one", async () => {
    const owner = await recording();
    const other = await signedIn();
    expect((await owner.rpc.sessions()).map((session) => session.id)).toEqual([owner.sessionId]);
    expect(await other.session.rpc.recording.sessions()).toEqual([]);
    const theirs = other.session.rpc.recording;
    await expectError(theirs.session({ sessionId: owner.sessionId }), "RECORDING_NOT_FOUND");
    await expectError(theirs.finish({ sessionId: owner.sessionId }), "RECORDING_NOT_FOUND");
    await expectError(theirs.remove({ sessionId: owner.sessionId }), "RECORDING_NOT_FOUND");
    await expectError(theirs.uploadSlice(slice(owner.sessionId, 0, 0)), "RECORDING_NOT_FOUND");
  });
});

/** A take of the member's, as the worker and the AI service make one for an attempt. */
async function takeOf(me: { id: string }, org: string, sessionId: string, attemptId: string) {
  const [made] = await sql<{ file: string; take: string }>(
    `WITH f AS (
       INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
       VALUES ($1, 'director-take-video', 'ready', 'attempt-1.mp4', 'video/mp4', 10, now()) RETURNING id),
     t AS (
       INSERT INTO ai.director_take (org_id, plan_id, user_id, shot_index, file_id, kind, updated_at)
       SELECT $2, s.plan_id, $1, 0, f.id, 'video', now() FROM app.recording_session s, f WHERE s.id = $3
       RETURNING id, file_id)
     SELECT file_id AS file, id AS take FROM t`,
    [me.id, org, sessionId],
  );
  const take = required(made, "a take");
  await sql("UPDATE app.recording_attempt SET file_id = $1, take_id = $2 WHERE id = $3", [
    take.file,
    take.take,
    attemptId,
  ]);
  return take;
}

describe("deleting a session", () => {
  it("deletes its takes and its footage at once, their objects queued for deletion", async () => {
    const { rpc, sessionId, me, org } = await recording();
    await rpc.uploadSlice(slice(sessionId, 0, 0));
    const attempt = await mark(rpc, sessionId, "start", 1, 0);
    const take = await takeOf(me, org, sessionId, attempt.id);
    expect(await rpc.remove({ sessionId })).toEqual({ removed: true });

    expect(await sql("SELECT id FROM app.recording_session WHERE id = $1", [sessionId])).toEqual(
      [],
    );
    expect(await sql("SELECT id FROM files.file WHERE id = $1", [take.file])).toEqual([]);
    expect(await sql("SELECT id FROM ai.director_take WHERE id = $1", [take.take])).toEqual([]);
    const queued = await sql<{ key: string }>(
      "SELECT key FROM files.object_deletion WHERE key LIKE $1 OR key LIKE $2",
      [`recordings/${sessionId}/%`, `files/${take.file}`],
    );
    // The part's joined copy too, in case a post-session pass left it behind.
    expect(queued.map((row) => row.key).sort()).toEqual(
      [
        `files/${take.file}`,
        `recordings/${sessionId}/0/0`,
        `recordings/${sessionId}/0/whole`,
      ].sort(),
    );
    await expectError(rpc.session({ sessionId }), "RECORDING_NOT_FOUND");
  });

  it("deletes only a take of the member's own, whatever file its attempt names", async () => {
    const { rpc, sessionId, org } = await recording();
    const attempt = await mark(rpc, sessionId, "start", 1, 0);
    const other = await recording();
    const otherAttempt = await mark(other.rpc, other.sessionId, "start", 1, 0);
    const theirs = await takeOf(other.me, other.org, other.sessionId, otherAttempt.id);
    const [avatar] = await sql<{ id: string }>(
      `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
       VALUES ((SELECT user_id FROM app.recording_session WHERE id = $1), 'avatar', 'ready', 'me.png',
               'image/png', 10, now()) RETURNING id`,
      [sessionId],
    );
    // A bug that pointed the attempts at someone else's take and at a file that's no take.
    await sql("UPDATE app.recording_attempt SET file_id = $1 WHERE id = $2", [
      theirs.file,
      attempt.id,
    ]);
    const second = await mark(rpc, sessionId, "start", 2, 5_000);
    await sql("UPDATE app.recording_attempt SET file_id = $1 WHERE id = $2", [
      required(avatar, "a file").id,
      second.id,
    ]);
    expect(await rpc.remove({ sessionId })).toEqual({ removed: true });

    expect(
      await sql("SELECT id FROM files.file WHERE id = ANY($1::uuid[])", [
        [theirs.file, required(avatar, "a file").id],
      ]),
    ).toHaveLength(2);
    expect(await sql("SELECT id FROM ai.director_take WHERE id = $1", [theirs.take])).toHaveLength(
      1,
    );
    expect(org).not.toBe(other.org);
  });

  it("lets the API write only the columns ending an attempt changes", async () => {
    const { rpc, sessionId, org } = await recording();
    const attempt = await mark(rpc, sessionId, "start", 1, 0);
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const ended = await client.query(
        "UPDATE app.recording_attempt SET end_ms = 4000, status = 'waiting', note = 'ok', updated_at = now() WHERE id = $1",
        [attempt.id],
      );
      expect(ended.rowCount).toBe(1);
      await client.query("COMMIT");
      for (const column of [
        "file_id = NULL",
        "take_id = NULL",
        "clip_start_ms = 0",
        "org_id = org_id",
      ]) {
        await expect(
          client.query(`UPDATE app.recording_attempt SET ${column} WHERE id = $1`, [attempt.id]),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });
});

describe("keeping footage a video was saved from", () => {
  it("keeps it another week, at most two after it was recorded, and the demo's a day", async () => {
    const { rpc, sessionId, me, org } = await recording();
    const attempt = await mark(rpc, sessionId, "start", 1, 0);
    const takeId = directorTakeIdSchema.parse((await takeOf(me, org, sessionId, attempt.id)).take);
    // Recorded ten days ago: another week would pass the two weeks.
    await sql(
      "UPDATE app.recording_session SET created_at = now() - interval '10 days' WHERE id = $1",
      [sessionId],
    );
    // Imported once the API has started: its modules read the environment it set.
    const { RecordingService } = await import("../src/modules/recording");
    const service = harness.app.get(RecordingService);
    const caller = { orgId: orgIdSchema.parse(org), userId: userIdSchema.parse(me.id) };
    await service.keepFootageOf(caller, [takeId]);
    const [kept] = await sql<{ days: number }>(
      "SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM app.recording_session WHERE id = $1",
      [sessionId],
    );
    expect(kept?.days).toBe(14);

    await sql("UPDATE app.recording_session SET demo = true, expires_at = now() WHERE id = $1", [
      sessionId,
    ]);
    const [before] = await sql<{ expires_at: Date }>(
      "SELECT expires_at FROM app.recording_session WHERE id = $1",
      [sessionId],
    );
    await service.keepFootageOf(caller, [takeId]);
    expect(
      await sql("SELECT expires_at FROM app.recording_session WHERE id = $1", [sessionId]),
    ).toEqual([before]);
  });
});

/** The first bytes of a WebM file (its EBML header), as a recorder's first slice starts. */
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];

describe("slices and the clipper", { tags: ["files"] }, () => {
  /** Signs a slice and sends its bytes (`head` first), as the browser does. */
  async function upload(rpc: Rpc, input: ReturnType<typeof slice>, head: number[] = WEBM) {
    const { upload: signed } = await rpc.uploadSlice(input);
    const target = required(signed, "a signed upload");
    const headers = Object.fromEntries(
      Object.entries(target.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
    );
    const body = new Uint8Array(input.size);
    body.set(head);
    const response = await fetch(target.url, { method: "PUT", headers, body });
    expect(response.ok).toBe(true);
    return rpc.completeSlice({
      sessionId: input.sessionId,
      partIndex: input.partIndex,
      index: input.index,
    });
  }

  it("counts each stored slice once, and signs nothing for one stored already", async () => {
    const { rpc, sessionId } = await recording();
    // Signed, but nothing sent yet.
    await rpc.uploadSlice(slice(sessionId, 0, 0));
    await expectError(
      rpc.completeSlice({ sessionId, partIndex: 0, index: 0 }),
      "RECORDING_SLICE_NOT_UPLOADED",
    );
    const stored = await upload(rpc, slice(sessionId, 0, 0));
    expect(stored).toMatchObject({ recordedMs: 10_000, bytes: 1_000 });
    const again = await rpc.completeSlice({ sessionId, partIndex: 0, index: 0 });
    expect(again).toMatchObject({ recordedMs: 10_000, bytes: 1_000 });
    expect(await rpc.uploadSlice(slice(sessionId, 0, 0))).toEqual({ upload: null });
    const { parts } = await rpc.session({ sessionId });
    expect(parts[0]?.uploaded).toEqual([0]);
  });

  it("refuses and deletes a part's first slice that isn't its recorder's kind of file", async () => {
    const { rpc, sessionId } = await recording();
    // A playlist pointing elsewhere, stored as a WebM part's first slice.
    const playlist = [...new TextEncoder().encode("#EXTM3U\n")];
    await expectError(upload(rpc, slice(sessionId, 0, 0), playlist), "RECORDING_SLICE_INVALID");
    expect(
      await sql("SELECT index FROM app.recording_slice WHERE session_id = $1", [sessionId]),
    ).toEqual([]);
    expect((await rpc.session({ sessionId })).bytes).toBe(0);
    // An MP4 part starts with its `ftyp` box.
    await rpc.addPart({ sessionId, index: 1, camera: "front", contentType: "video/mp4" });
    const ftyp = [0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")];
    expect(await upload(rpc, slice(sessionId, 1, 0), ftyp)).toMatchObject({ bytes: 1_000 });
  });

  it("queues an ended attempt once its footage is stored, and one open at Done once its part ends", async () => {
    const { rpc, sessionId, org } = await recording();
    const covered = await mark(rpc, sessionId, "start", 1, 1_000);
    await mark(rpc, sessionId, "end", 1, 12_000);
    const toTheEnd = await mark(rpc, sessionId, "start", 2, 15_000);

    await upload(rpc, slice(sessionId, 0, 0));
    expect(await clipJob(covered.id)).toBeUndefined();
    await upload(rpc, slice(sessionId, 0, 1), []);
    expect(await clipJob(covered.id)).toEqual({ attemptId: covered.id, orgId: org });

    await rpc.finish({ sessionId });
    expect(await clipJob(toTheEnd.id)).toBeUndefined();
    await rpc.closePart({ sessionId, index: 0, sliceCount: 2 });
    expect(await clipJob(toTheEnd.id)).toEqual({ attemptId: toTheEnd.id, orgId: org });
    const { attempts } = await rpc.session({ sessionId });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["clipping", "clipping"]);
  });
});
