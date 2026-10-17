/**
 * A stand-in for the Python AI service (apps/ai), answering the API the way the real one
 * does. The API checks the contract (packages/ai-client validates every response), and
 * apps/ai's own tests cover the service itself. Director's plans, takes and scene checks
 * are what a test sets for its short (`PUT /__fake/director/<videoId>`, the
 * `fakeDirector` command).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    : {};
}

/** What Director answers for one short: set by the test, takes added as they're sent. */
interface DirectorShort {
  plan?: Record<string, unknown>;
  takes: Record<string, unknown>[];
  scene?: Record<string, unknown>;
}

export async function startFakeAi() {
  const shorts = new Map<string, DirectorShort>();
  const short = (videoId: string) => {
    const found = shorts.get(videoId) ?? { takes: [] };
    shorts.set(videoId, found);
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
    const director = directorRoute(route, input, short);
    if (director) {
      return reply(director.status, director.body);
    }
    fail(404, "NOT_FOUND");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secret: `web-tests-ai-${randomUUID()}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const now = () => new Date().toISOString();

/** Director's routes (apps/ai/app/director.py), answered from what the test set. */
function directorRoute(
  route: string,
  input: Record<string, unknown>,
  short: (videoId: string) => DirectorShort,
): { status: number; body?: unknown } | null {
  const notFound = (code: string) => ({
    status: 404,
    body: { defined: true, code, status: 404, message: code, data: { params: {} } },
  });
  const set = /^PUT \/__fake\/director\/([\w-]{11})$/.exec(route);
  if (set?.[1]) {
    Object.assign(short(set[1]), input);
    return { status: 204 };
  }
  const plan = /^GET \/v1\/director\/plans\/([\w-]{11})$/.exec(route);
  if (plan?.[1]) {
    const found = short(plan[1]).plan;
    return found
      ? {
          status: 200,
          body: {
            id: randomUUID(),
            videoId: plan[1],
            error: null,
            model: "stand-in",
            createdAt: now(),
            updatedAt: now(),
            ...found,
          },
        }
      : notFound("DIRECTOR_PLAN_NOT_FOUND");
  }
  const takes = /^GET \/v1\/director\/plans\/([\w-]{11})\/takes$/.exec(route);
  if (takes?.[1]) {
    return { status: 200, body: short(takes[1]).takes };
  }
  if (route === "POST /v1/director/scene-checks") {
    const scene = short(String(input.videoId)).scene;
    return scene ? { status: 200, body: scene } : notFound("DIRECTOR_PLAN_NOT_FOUND");
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
      createdAt: now(),
    };
    short(String(input.videoId)).takes.unshift(take);
    return { status: 201, body: take };
  }
  return null;
}
