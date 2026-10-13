/**
 * A stand-in for the Python AI service (apps/ai), answering the API the way the real one
 * does: its documents, sentiment and the assistant's event stream, scoped to the
 * organization in the per-call token. The API checks the contract (packages/ai-client
 * validates every response), and apps/ai's own tests cover the service itself.
 *
 * Tests steer it through what they type: a document titled "… [ready]" or "… [failed]"
 * is in that state, and a question with "[budget]" or "[broken]" is refused or breaks
 * mid-answer. Director's plans, takes and scene checks are what a test sets for its short
 * (`PUT /__fake/director/<videoId>`, the `fakeDirector` command).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Doc {
  id: string;
  org: string;
  title: string;
  status: "pending" | "ready" | "failed";
  error: string | null;
  chunkCount: number;
  summary: string | null;
  createdBy: string;
  createdAt: string;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    : {};
}

/** The caller the API signed the token for (its signature is the API's own tests' job). */
function caller(request: IncomingMessage) {
  const token = String(request.headers.authorization ?? "").split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(token, "base64url").toString() || "{}") as {
    org?: unknown;
    sub?: unknown;
  };
  return { org: String(claims.org), user: String(claims.sub) };
}

/** A new document, in the state its title asks for (`[ready]`, `[failed]`, else pending). */
function newDocument(input: Record<string, unknown>, org: string, user: string): Doc {
  const title = String(input.title);
  const status =
    (["ready", "failed"] as const).find((state) => title.includes(`[${state}]`)) ?? "pending";
  return {
    id: randomUUID(),
    org,
    title,
    status,
    error: status === "failed" ? "DOCUMENT_INDEXING_FAILED" : null,
    chunkCount: status === "ready" ? 3 : 0,
    summary: status === "ready" ? `A summary of ${title}` : null,
    createdBy: user,
    createdAt: new Date().toISOString(),
  };
}

/** The assistant's streamed answer; `[broken]` in the question ends it with an error. */
function streamAnswer(question: string, response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify({ event })}\n\n`);
  send({ type: "text", text: "Refunds take " });
  send({ type: "text", text: "five days." });
  if (question.includes("[broken]")) {
    send({ type: "error", code: "AI_RUN_LIMIT" });
    return response.end();
  }
  send({ type: "sources", sources: [{ documentId: randomUUID(), title: "Handbook" }] });
  send({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } });
  return response.end();
}

/** What Director answers for one short: set by the test, takes added as they're sent. */
interface DirectorShort {
  plan?: Record<string, unknown>;
  takes: Record<string, unknown>[];
  scene?: Record<string, unknown>;
}

export async function startFakeAi() {
  const documents: Doc[] = [];
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
    const { org, user } = caller(request);
    const path = new URL(request.url ?? "/", "http://ai").pathname;
    const route = `${request.method} ${path}`;
    const input = await body(request);

    const routes: Record<string, () => void> = {
      "GET /health/ready": () => reply(200, {}),
      "POST /v1/sentiment": () => reply(200, { label: "positive", score: 0.87, model: "stand-in" }),
      "GET /v1/documents": () =>
        reply(
          200,
          documents.filter((doc) => doc.org === org),
        ),
      "POST /v1/documents": () => {
        const doc = newDocument(input, org, user);
        documents.push(doc);
        reply(201, doc);
      },
      "POST /v1/assistant/answers": () => {
        const question = String(input.question);
        if (question.includes("[budget]")) {
          return fail(429, "AI_BUDGET_EXCEEDED");
        }
        return streamAnswer(question, response);
      },
    };
    const handle = routes[route];
    if (handle) {
      return handle();
    }
    const director = directorRoute(route, input, short);
    if (director) {
      return reply(director.status, director.body);
    }
    const remove = /^DELETE \/v1\/documents\/([0-9a-f-]{36})$/.exec(route);
    if (remove) {
      const index = documents.findIndex((doc) => doc.id === remove[1] && doc.org === org);
      if (index === -1) {
        return fail(404, "DOCUMENT_NOT_FOUND");
      }
      documents.splice(index, 1);
      return reply(204);
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
