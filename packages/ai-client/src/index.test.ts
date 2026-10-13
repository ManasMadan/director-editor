/**
 * The client against a stand-in for the Python service on a local port: it answers the
 * way the real one does (error bodies, the event stream) and, per test, the way a broken
 * one might. The real service's own tests are in apps/ai.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiServiceError, createAiClient } from "./index";

const SECRET = "s".repeat(32);
const caller = { userId: "user-1", orgId: "org-1", requestId: "req-1" };
const doc = {
  id: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6b",
  title: "Handbook",
  status: "ready",
  error: null,
  chunkCount: 3,
  summary: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
};

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
let server: Server;
let baseUrl: string;
let handler: Handler;
const seen: { method: string; path: string; headers: IncomingMessage["headers"]; body: string }[] =
  [];

const json = (response: ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};
const failure = (code: string, status: number, data: object) => ({
  defined: true,
  code,
  status,
  message: code,
  data,
});

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    seen.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body,
    });
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

const client = () => createAiClient({ baseUrl, secret: SECRET });
const failed = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.fail("expected the call to fail"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(AiServiceError);
      return error as AiServiceError;
    },
  );

describe("each call", () => {
  it("carries a short-lived token naming the user and organization, and the request id", async () => {
    handler = (_request, response) => json(response, 200, []);
    await client().listDocuments(caller);
    const [call] = seen;
    const token = String(call?.headers.authorization).replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: "api",
      audience: "ai",
    });
    expect(payload).toMatchObject({ sub: "user-1", org: "org-1" });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(60);
    expect(call?.headers["x-request-id"]).toBe("req-1");
  });

  it("sends no request id when the caller has none", async () => {
    handler = (_request, response) => json(response, 200, []);
    await client().listDocuments({ userId: "u", orgId: "o" });
    expect(seen[0]?.headers).not.toHaveProperty("x-request-id");
  });
});

describe("documents and sentiment", () => {
  it("returns what the service answered", async () => {
    handler = (request, response, body) => {
      if (request.url === "/v1/sentiment") {
        json(response, 200, { label: "positive", model: "local", score: 0.9, echo: body });
      } else if (request.method === "POST") {
        json(response, 201, doc);
      } else if (request.method === "DELETE") {
        response.writeHead(204).end();
      } else {
        json(response, 200, [doc]);
      }
    };
    const ai = client();
    await expect(ai.sentiment(caller, "Great!")).resolves.toMatchObject({ label: "positive" });
    await expect(ai.listDocuments(caller)).resolves.toEqual([doc]);
    await expect(ai.createDocument(caller, { title: "Handbook", content: "…" })).resolves.toEqual(
      doc,
    );
    await expect(ai.deleteDocument(caller, doc.id)).resolves.toBeUndefined();
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/sentiment",
      "GET /v1/documents",
      "POST /v1/documents",
      `DELETE /v1/documents/${doc.id}`,
    ]);
  });

  it("throws the service's error with its code, params and issues", async () => {
    handler = (_request, response) =>
      json(
        response,
        422,
        failure("VALIDATION_FAILED", 422, {
          params: { max: 5000 },
          issues: [{ code: "too_big", path: ["text"] }],
        }),
      );
    const error = await failed(client().sentiment(caller, "x"));
    expect(error).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      params: { max: 5000 },
      issues: [{ code: "too_big", path: ["text"] }],
    });
  });

  it("gives an error without issues an empty list", async () => {
    handler = (_request, response) =>
      json(response, 404, failure("NOT_FOUND", 404, { params: {} }));
    const error = await failed(client().deleteDocument(caller, doc.id));
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND", issues: [] });
  });

  it("calls anything but an error body an outage", async () => {
    handler = (_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<h1>Bad gateway</h1>");
    };
    const error = await failed(client().listDocuments(caller));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("refuses a successful answer that breaks the contract", async () => {
    handler = (_request, response) => json(response, 200, { label: "ecstatic" });
    const error = await failed(client().sentiment(caller, "Great!"));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("refuses a successful answer that isn't JSON", async () => {
    handler = (_request, response) => response.writeHead(200).end("positive");
    const error = await failed(client().sentiment(caller, "Great!"));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("says the service is unavailable when nothing listens", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const ai = createAiClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
    const error = await failed(ai.listDocuments(caller));
    expect(error).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
    const answer = await failed(ai.answer(caller, "Hello?"));
    expect(answer).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
    expect(answer.cause).toBeInstanceOf(Error);
  });

  it("gives up on a call that hangs", async () => {
    handler = () => undefined;
    const ai = createAiClient({ baseUrl, secret: SECRET, timeoutMs: 100 });
    const error = await failed(ai.listDocuments(caller));
    expect(error).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("an answer", () => {
  const stream =
    (frames: string[]): Handler =>
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) {
        response.write(frame);
      }
      response.end();
    };
  const collect = async (events: AsyncGenerator<unknown>) => {
    const out: unknown[] = [];
    for await (const event of events) {
      out.push(event);
    }
    return out;
  };

  it("streams the service's events, however the frames are split", async () => {
    handler = stream([
      ": keep-alive\n\n",
      'data: {"event": {"type": "sources", "sources": []}}\n\ndata: {"event": ',
      '{"type": "text", "text": "Hi"}}\n\n',
      'data: {"event": {"type": "done", "usage": {"inputTokens": 1, "outputTokens": 2}}}\n\n',
    ]);
    const events = await client().answer(caller, "Hello?");
    await expect(collect(events)).resolves.toEqual([
      { type: "sources", sources: [] },
      { type: "text", text: "Hi" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ question: "Hello?" });
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
  });

  it("fails on an event that breaks the contract", async () => {
    handler = stream(['data: {"event": {"type": "tokn"}}\n\n']);
    const events = await client().answer(caller, "Hello?");
    await expect(collect(events)).rejects.toThrow();
  });

  it("throws a refusal before any event", async () => {
    handler = (_request, response) =>
      json(response, 403, failure("FEATURE_DISABLED", 403, { params: { feature: "ai" } }));
    const error = await failed(client().answer(caller, "Hello?"));
    expect(error).toMatchObject({
      status: 403,
      code: "FEATURE_DISABLED",
      params: { feature: "ai" },
    });
  });

  it("calls an unreadable refusal an outage", async () => {
    handler = (_request, response) => response.writeHead(500).end("oops");
    const error = await failed(client().answer(caller, "Hello?"));
    expect(error).toMatchObject({ status: 500, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("calls an answer with no body an outage", async () => {
    handler = (_request, response) => response.writeHead(204).end();
    const error = await failed(client().answer(caller, "Hello?"));
    expect(error).toMatchObject({ status: 204, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("stops when the caller goes away", async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = failed(client().answer(caller, "Hello?", controller.signal));
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  });
});
