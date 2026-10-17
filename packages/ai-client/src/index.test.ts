/**
 * The client against a stand-in for the Python service on a local port: it answers the
 * way the real one does (error bodies) and, per test, the way a broken one might. The
 * real service's own tests are in apps/ai.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiServiceError, createAiClient } from "./index";

const SECRET = "s".repeat(32);
const VIDEO = "dQw4w9WgXcQ";
const caller = { userId: "user-1", orgId: "org-1", requestId: "req-1" };
const plan = {
  id: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6b",
  videoId: VIDEO,
  source: "user",
  status: "pending",
  stage: "queued",
  error: null,
  plan: null,
  model: null,
  audioStatus: "none",
  audioKey: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const take = {
  id: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6c",
  shotIndex: 0,
  fileId: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6d",
  kind: "video",
  status: "pending",
  error: null,
  bestStartMs: null,
  bestEndMs: null,
  score: null,
  feedback: null,
  createdAt: "2026-01-01T00:00:00Z",
};
const cut = {
  id: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6e",
  planId: plan.id,
  videoId: VIDEO,
  templateTitle: "Pen drop",
  title: "My pen drop",
  picks: [{ shotIndex: 0, takeId: take.id }],
  fileId: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a6f",
  durationMs: 4000,
  publishStatus: "none",
  youtubeVideoId: null,
  visibility: null,
  createdAt: "2026-01-01T00:00:00Z",
};
const scene = {
  direction: "none",
  distanceMeters: null,
  inPlace: true,
  instruction: "Good spot.",
  landmark: null,
  lighting: "good",
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
    await client().director.listTakes(caller, VIDEO);
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
    await client().director.listTakes({ userId: "u", orgId: "o" }, VIDEO);
    expect(seen[0]?.headers).not.toHaveProperty("x-request-id");
  });
});

describe("Director's calls", () => {
  it("return what the service answered", async () => {
    handler = (request, response) => {
      const answers: Record<string, [number, unknown]> = {
        "/v1/director/scene-checks": [200, scene],
        "/v1/director/takes": [201, take],
        [`/v1/director/plans/${VIDEO}/takes`]: [200, [take]],
        "/v1/director/library": [200, { templates: [plan], indexUsed: true }],
        "/v1/director/cuts": request.method === "POST" ? [201, cut] : [200, [cut]],
        [`/v1/director/plans/${VIDEO}/cuts`]: [200, [cut]],
      };
      const [status, payload] = answers[request.url ?? ""] ?? [200, plan];
      json(response, status, payload);
    };
    const { director } = client();
    await expect(director.index(caller, VIDEO)).resolves.toEqual(plan);
    await expect(director.library(caller)).resolves.toEqual({
      templates: [plan],
      indexUsed: true,
    });
    await expect(director.getPlan(caller, VIDEO)).resolves.toEqual(plan);
    await expect(
      director.checkScene(caller, { videoId: VIDEO, shotIndex: 0, image: "a".repeat(100) }),
    ).resolves.toEqual(scene);
    await expect(
      director.createTake(caller, {
        videoId: VIDEO,
        shotIndex: 0,
        fileId: take.fileId,
        kind: "video",
        contentType: "video/webm",
        sourceUrl: "https://files.example.com/take",
      }),
    ).resolves.toEqual(take);
    await expect(director.listTakes(caller, VIDEO)).resolves.toEqual([take]);
    await expect(
      director.createCut(caller, {
        videoId: VIDEO,
        title: cut.title,
        fileId: cut.fileId,
        picks: cut.picks,
      }),
    ).resolves.toEqual(cut);
    await expect(director.listCuts(caller, VIDEO)).resolves.toEqual([cut]);
    await expect(director.listMedia(caller)).resolves.toEqual([cut]);
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/director/plans",
      "GET /v1/director/library",
      `GET /v1/director/plans/${VIDEO}`,
      "POST /v1/director/scene-checks",
      "POST /v1/director/takes",
      `GET /v1/director/plans/${VIDEO}/takes`,
      "POST /v1/director/cuts",
      `GET /v1/director/plans/${VIDEO}/cuts`,
      "GET /v1/director/cuts",
    ]);
  });

  it("throw the service's error with its code, params and issues", async () => {
    handler = (_request, response) =>
      json(
        response,
        422,
        failure("VALIDATION_FAILED", 422, {
          params: { max: 11 },
          issues: [{ code: "too_big", path: ["videoId"] }],
        }),
      );
    const error = await failed(client().director.index(caller, VIDEO));
    expect(error).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      params: { max: 11 },
      issues: [{ code: "too_big", path: ["videoId"] }],
    });
  });

  it("give an error without issues an empty list", async () => {
    handler = (_request, response) =>
      json(response, 404, failure("DIRECTOR_PLAN_NOT_FOUND", 404, { params: {} }));
    const error = await failed(client().director.getPlan(caller, VIDEO));
    expect(error).toMatchObject({ status: 404, code: "DIRECTOR_PLAN_NOT_FOUND", issues: [] });
  });

  it("call anything but an error body an outage", async () => {
    handler = (_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<h1>Bad gateway</h1>");
    };
    const error = await failed(client().director.listTakes(caller, VIDEO));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("refuse a successful answer that breaks the contract", async () => {
    handler = (_request, response) => json(response, 200, { status: "watching" });
    const error = await failed(client().director.getPlan(caller, VIDEO));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("refuse a successful answer that isn't JSON", async () => {
    handler = (_request, response) => response.writeHead(200).end("ready");
    const error = await failed(client().director.getPlan(caller, VIDEO));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("say the service is unavailable when nothing listens", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const ai = createAiClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
    const error = await failed(ai.director.listTakes(caller, VIDEO));
    expect(error).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("give up on a call that hangs", async () => {
    handler = () => undefined;
    const ai = createAiClient({ baseUrl, secret: SECRET, timeoutMs: 100 });
    const error = await failed(ai.director.listTakes(caller, VIDEO));
    expect(error).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  });
});
