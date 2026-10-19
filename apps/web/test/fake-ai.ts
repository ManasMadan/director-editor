/**
 * A stand-in for the Python AI service (apps/ai), answering the API the way the real one
 * does. The API checks the contract (packages/ai-client validates every response), and
 * apps/ai's own tests cover the service itself. Director's plans, takes and cuts
 * are what a test sets for its short (`PUT /__fake/director/<videoId>`, the
 * `fakeDirector` command); cuts the editor saves are added, each the caller's own (the
 * `userId` of a cut a test sets), as My media lists them. A workspace's library is what a
 * test sets for it (`PUT /__fake/library/<orgId>`, the `fakeLibrary` command), and
 * indexing a short adds to it as the real service does: once per member, a short already
 * there answered with its plan.
 * A cut's YouTube post, and the cut as publishing reads it, are what a test sets
 * for it (`PUT /__fake/cuts/<cutId>`, the `fakeCut` command). Where publishing got is
 * what the API wrote on the cut's row in the tests' database, read back as apps/ai reads
 * it, so the cut lists change once a publish lands.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import * as z from "zod";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    : {};
}

/** A workspace's library: its plans (newest first), and whether the member indexed one. */
interface Library {
  templates: Record<string, unknown>[];
  indexUsed: boolean;
  /** What indexing a new short answers instead, when the test sets it: `{ status, code }`. */
  indexError?: { status: number; code: string };
}

/** The workspace a call is made for: the `org` claim of the API's token (not checked here). */
function orgOf(request: IncomingMessage): string {
  const token = request.headers.authorization?.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(token, "base64url").toString() || "{}") as {
    org?: string;
  };
  return claims.org ?? "";
}

/** What Director answers for one short: set by the test, takes added as they're sent. */
interface DirectorShort {
  plan?: Record<string, unknown>;
  takes: Record<string, unknown>[];
  cuts: Record<string, unknown>[];
}

/** Who the API says is calling: the subject of its token (checked by the real service). */
function callerOf(request: IncomingMessage): string {
  const token = request.headers.authorization?.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(token, "base64url").toString() || "{}") as {
    sub?: string;
  };
  return claims.sub ?? "";
}

/** A cut as this stand-in answers it: any fields, and its id. */
const cutBody = z.looseObject({ id: z.string() });
type CutBody = z.infer<typeof cutBody>;

const publishingRow = z.object({
  id: z.string(),
  publishStatus: z.string(),
  youtubeVideoId: z.string().nullable(),
  visibility: z.string().nullable(),
});

/** Where each of these cuts' publishing got, by id, for those with a row in the database. */
async function publishingOf(database: pg.Pool, ids: string[]) {
  const { rows } = await database.query(
    `SELECT id::text, publish_status AS "publishStatus", youtube_video_id AS "youtubeVideoId",
            visibility
       FROM ai.director_cut WHERE id::text = ANY($1)`,
    [ids],
  );
  return new Map(
    z
      .array(publishingRow)
      .parse(rows)
      .map(({ id, ...publishing }) => [id, publishing]),
  );
}

/** A cut, or a list of them, with where publishing got, from the database. */
async function withPublishing(database: pg.Pool, body: unknown): Promise<unknown> {
  const many = z.array(cutBody).safeParse(body);
  const cuts: CutBody[] = many.success ? many.data : [cutBody.parse(body)];
  const stored = await publishingOf(
    database,
    cuts.map((cut) => cut.id),
  );
  const overlaid = cuts.map((cut) => ({ ...cut, ...stored.get(cut.id) }));
  return many.success ? overlaid : overlaid[0];
}

export async function startFakeAi(databaseUrl: string) {
  const database = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const shorts = new Map<string, DirectorShort>();
  const short = (videoId: string) => {
    const found = shorts.get(videoId) ?? { takes: [], cuts: [] };
    shorts.set(videoId, found);
    return found;
  };
  const publishable = new Map<string, FakeCut>();
  const libraries = new Map<string, Library>();
  const library = (orgId: string) => {
    const found = libraries.get(orgId) ?? { templates: [], indexUsed: false };
    libraries.set(orgId, found);
    return found;
  };
  const server = createServer(async (request, response) => {
    const reply = (status: number, payload?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    const fail = (status: number, code: string) =>
      reply(status, { defined: true, code, status, message: code, data: { params: {} } });
    const path = new URL(request.url ?? "/", "http://ai").pathname;
    const route = `${request.method} ${path}`;
    const input = await body(request);

    if (route === "GET /health/ready") {
      return reply(200, {});
    }
    const indexed = libraryRoute(route, input, orgOf(request), library, short);
    if (indexed) {
      return reply(indexed.status, indexed.body);
    }
    const director =
      directorRoute(route, input, short) ??
      cutRoute(route, input, callerOf(request), shorts, short) ??
      publishRoute(route, input, publishable);
    if (director) {
      const read = director.status === 200 && /^GET \/v1\/director\/cuts/.test(route);
      if (!read) {
        return reply(director.status, director.body);
      }
      // A query that fails answers as the real service would, not with a request that hangs.
      return withPublishing(database, director.body).then(
        (cuts) => reply(director.status, cuts),
        () => fail(500, "INTERNAL"),
      );
    }
    fail(404, "NOT_FOUND");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secret: `web-tests-ai-${randomUUID()}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await database.end();
    },
  };
}

const now = () => new Date().toISOString();

/** A plan as the service answers it: what the test set, over an id and the defaults. */
const planBody = (videoId: string, found: Record<string, unknown>) => ({
  id: randomUUID(),
  videoId,
  source: "user",
  stage: "queued",
  error: null,
  model: "stand-in",
  audioStatus: "none",
  audioKey: null,
  createdAt: now(),
  updatedAt: now(),
  ...found,
});

const failure = (status: number, code: string) => ({
  status,
  body: { defined: true, code, status, message: code, data: { params: {} } },
});

/**
 * The library's routes: the test sets a workspace's library (each plan also becomes its
 * short's, for the plan route), reads it back, and indexes a short into it.
 */
function libraryRoute(
  route: string,
  input: Record<string, unknown>,
  orgId: string,
  library: (orgId: string) => Library,
  short: (videoId: string) => DirectorShort,
): { status: number; body?: unknown } | null {
  const set = /^PUT \/__fake\/library\/([\w-]+)$/.exec(route);
  if (set?.[1]) {
    const found = library(set[1]);
    Object.assign(found, input);
    found.templates = found.templates.map((plan) => {
      const body = planBody(String(plan.videoId), plan);
      short(String(plan.videoId)).plan = body;
      return body;
    });
    return { status: 204 };
  }
  if (route === "GET /v1/director/library") {
    const { templates, indexUsed } = library(orgId);
    return { status: 200, body: { templates, indexUsed } };
  }
  if (route !== "POST /v1/director/plans") {
    return null;
  }
  const videoId = String(input.videoId);
  const found = library(orgId);
  const existing = found.templates.find((plan) => plan.videoId === videoId);
  if (existing) {
    return { status: 200, body: existing };
  }
  if (found.indexError) {
    return failure(found.indexError.status, found.indexError.code);
  }
  if (found.indexUsed) {
    return failure(409, "DIRECTOR_INDEX_LIMIT");
  }
  const plan = planBody(videoId, { status: "pending", plan: null });
  found.templates.unshift(plan);
  found.indexUsed = true;
  short(videoId).plan = plan;
  return { status: 200, body: plan };
}

/** Director's routes (apps/ai/app/director.py), answered from what the test set. */
function directorRoute(
  route: string,
  input: Record<string, unknown>,
  short: (videoId: string) => DirectorShort,
): { status: number; body?: unknown } | null {
  const notFound = (code: string) => failure(404, code);
  const set = /^PUT \/__fake\/director\/([\w-]{11})$/.exec(route);
  if (set?.[1]) {
    Object.assign(short(set[1]), input);
    return { status: 204 };
  }
  const plan = /^GET \/v1\/director\/plans\/([\w-]{11})$/.exec(route);
  if (plan?.[1]) {
    const found = short(plan[1]).plan;
    return found
      ? { status: 200, body: planBody(plan[1], found) }
      : notFound("DIRECTOR_PLAN_NOT_FOUND");
  }
  const takes = /^GET \/v1\/director\/plans\/([\w-]{11})\/takes$/.exec(route);
  if (takes?.[1]) {
    return { status: 200, body: short(takes[1]).takes };
  }
  if (route === "POST /v1/director/takes") {
    const take = {
      id: randomUUID(),
      shotIndex: input.shotIndex,
      fileId: input.fileId,
      kind: input.kind,
      status: "pending",
      error: null,
      bestStartMs: null,
      bestEndMs: null,
      score: null,
      feedback: null,
      reason: null,
      chosen: false,
      origin: "shoot",
      createdAt: now(),
    };
    short(String(input.videoId)).takes.unshift(take);
    return { status: 201, body: take };
  }
  return null;
}

/** How long a picked take lasts in a cut: its best part, or its shot's length. */
function pickMs(found: DirectorShort, pick: { shotIndex: number; takeId: string }): number {
  const take = found.takes.find((each) => each.id === pick.takeId);
  if (typeof take?.bestStartMs === "number" && typeof take.bestEndMs === "number") {
    // Under half a second is no best part (app/director.py MIN_BEST_MS).
    const best = take.bestEndMs - take.bestStartMs;
    if (best >= 500) {
      return best;
    }
  }
  const plan = found.plan?.plan as { shots: { durationSeconds: number }[] } | undefined;
  return Math.round((plan?.shots[pick.shotIndex]?.durationSeconds ?? 0) * 1000);
}

/** The caller's cuts (apps/ai/app/director.py's save_cut and cuts), without who made them. */
function cutRoute(
  route: string,
  input: Record<string, unknown>,
  caller: string,
  shorts: Map<string, DirectorShort>,
  short: (videoId: string) => DirectorShort,
): { status: number; body?: unknown } | null {
  const own = (cuts: Record<string, unknown>[]) =>
    cuts.filter((cut) => cut.userId === caller).map(({ userId: _, ...cut }) => cut);
  if (route === "POST /v1/director/cuts") {
    const videoId = String(input.videoId);
    const found = short(videoId);
    const picks = input.picks as { shotIndex: number; takeId: string }[];
    const plan = found.plan?.plan as { title: string } | undefined;
    const cut = {
      id: randomUUID(),
      planId: randomUUID(),
      videoId,
      templateTitle: plan?.title ?? "",
      title: input.title,
      picks,
      fileId: input.fileId,
      // The editor's figure, else the picks added up.
      durationMs:
        typeof input.durationMs === "number"
          ? input.durationMs
          : picks.reduce((sum, pick) => sum + pickMs(found, pick), 0),
      createdAt: now(),
      publishStatus: "none",
      youtubeVideoId: null,
      visibility: null,
    };
    found.cuts.unshift({ ...cut, userId: caller });
    return { status: 201, body: cut };
  }
  if (route === "GET /v1/director/cuts") {
    const all = own([...shorts.values()].flatMap((found) => found.cuts));
    return {
      status: 200,
      body: all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    };
  }
  const cuts = /^GET \/v1\/director\/plans\/([\w-]{11})\/cuts$/.exec(route);
  return cuts?.[1] ? { status: 200, body: own(short(cuts[1]).cuts) } : null;
}

/** A cut as a test set it, and the post Gemini writes for it (none: Gemini fails). */
interface FakeCut {
  cut: Record<string, unknown>;
  copy?: Record<string, unknown>;
}

/** A cut's routes: reading it, and Gemini's YouTube post for it. */
function publishRoute(
  route: string,
  input: Record<string, unknown>,
  cuts: Map<string, FakeCut>,
): { status: number; body?: unknown } | null {
  const set = /^PUT \/__fake\/cuts\/([\w-]+)$/.exec(route);
  if (set?.[1]) {
    cuts.set(set[1], input as unknown as FakeCut);
    return { status: 204 };
  }
  const read = /^GET \/v1\/director\/cuts\/([\w-]+)$/.exec(route);
  if (read?.[1]) {
    const found = cuts.get(read[1]);
    return found ? { status: 200, body: found.cut } : failure(404, "DIRECTOR_CUT_NOT_FOUND");
  }
  if (route === "POST /v1/director/publish-copy") {
    const copy = cuts.get(String(input.cutId))?.copy;
    return copy ? { status: 200, body: copy } : failure(502, "UPSTREAM_UNAVAILABLE");
  }
  return null;
}
