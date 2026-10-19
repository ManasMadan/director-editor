/**
 * The client against a stand-in for the Python service on a local port: it answers the
 * way the real one does (error bodies) and, per test, the way a broken one might. The
 * real service's own tests are in apps/ai.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
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
  reason: null,
  chosen: false,
  origin: "shoot",
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
const copy = {
  title: "My pen drop",
  description: "Tried the trend.",
  hashtags: ["pendrop"],
  credits: "Inspired by Maya.",
};
const located = {
  found: true,
  label: "your window",
  box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
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
  it("keep their types (a client typed any would hide every contract change from the API)", () => {
    type Director = ReturnType<typeof createAiClient>["director"];
    expectTypeOf<Director>().not.toBeAny();
    expectTypeOf<Awaited<ReturnType<Director["library"]>>>().toHaveProperty("templates");
    expectTypeOf<Awaited<ReturnType<Director["askEditor"]>>>().not.toBeAny();
  });

  it("return what the service answered", async () => {
    handler = (request, response) => {
      const answers: Record<string, [number, unknown]> = {
        "/v1/director/locate": [200, located],
        "/v1/director/takes": [201, take],
        [`/v1/director/plans/${VIDEO}/takes`]: [200, [take]],
        [`/v1/director/plans/${VIDEO}/choices`]: [204, undefined],
        "/v1/director/library": [200, { templates: [plan], indexUsed: true }],
        "/v1/director/cuts": request.method === "POST" ? [201, cut] : [200, [cut]],
        [`/v1/director/plans/${VIDEO}/cuts`]: [200, [cut]],
        [`/v1/director/cuts/${cut.id}`]: [200, cut],
        "/v1/director/publish-copy": [200, copy],
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
      director.locate(caller, { target: "the window", image: "a".repeat(100) }),
    ).resolves.toEqual(located);
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
      director.chooseTake(caller, VIDEO, { shotIndex: 0, takeId: take.id }),
    ).resolves.toBeUndefined();
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
    await expect(director.getCut(caller, cut.id)).resolves.toEqual(cut);
    await expect(
      director.writePublishCopy(caller, {
        cutId: cut.id,
        original: { title: "Pen drop", channel: "Maya" },
      }),
    ).resolves.toEqual(copy);
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/director/plans",
      "GET /v1/director/library",
      `GET /v1/director/plans/${VIDEO}`,
      "POST /v1/director/locate",
      "POST /v1/director/takes",
      `GET /v1/director/plans/${VIDEO}/takes`,
      `POST /v1/director/plans/${VIDEO}/choices`,
      "POST /v1/director/cuts",
      `GET /v1/director/plans/${VIDEO}/cuts`,
      "GET /v1/director/cuts",
      `GET /v1/director/cuts/${cut.id}`,
      "POST /v1/director/publish-copy",
    ]);
  });

  it("line up a match cut", async () => {
    const alignment = {
      status: "aligned",
      outgoingEndMs: 1500,
      incomingStartMs: 0,
      transform: { x: -12.5, y: 4, scale: 0.97, rotation: -1.2 },
      offsetBeforePx: 61.3,
      offsetPx: 1.4,
      scaleDiff: 0.004,
      rotationDiff: 0.1,
      cropPercent: 3.2,
      withinTolerance: true,
      anchor: { x: 0.5, y: 0.4 },
      outgoingFrame: null,
      incomingFrame: null,
    };
    handler = (_request, response) => json(response, 200, alignment);
    const cut = {
      anchor: "the watch",
      outgoing: { url: "https://files.example.com/a", atMs: 1500 },
      incoming: { url: "https://files.example.com/b", atMs: 0 },
    };
    await expect(client().director.alignMatchCut(caller, cut)).resolves.toEqual(alignment);
    expect(seen.map(({ method, path, body }) => [`${method} ${path}`, body])).toEqual([
      ["POST /v1/director/match-cuts", JSON.stringify(cut)],
    ]);
  });

  it("count a turn of the slower line: reserved, then settled", async () => {
    handler = (request, response) =>
      request.url === "/v1/director/chat-reservations"
        ? json(response, 201, { tokens: 20_000 })
        : json(response, 204, undefined);
    const { director } = client();
    await expect(director.reserveChatTurn(caller, { model: "gemini-chat" })).resolves.toEqual({
      tokens: 20_000,
    });
    const used = { model: "gemini-chat", reserved: 20_000, inputTokens: 3_000, outputTokens: 40 };
    await expect(director.settleChatTurn(caller, used)).resolves.toBeUndefined();
    expect(seen.map(({ method, path, body }) => [`${method} ${path}`, body])).toEqual([
      ["POST /v1/director/chat-reservations", JSON.stringify({ model: "gemini-chat" })],
      ["POST /v1/director/chat-usage", JSON.stringify(used)],
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

describe("the asset picker's calls", () => {
  const slot = { videoId: VIDEO, assetId: "a1" };
  const candidate = {
    assetId: "a1",
    createdAt: "2026-01-01T00:00:00Z",
    credit: null,
    error: null,
    fileId: null,
    id: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a70",
    objectKey: null,
    origin: "created",
    prompt: "A red umbrella on a white table",
    status: "pending",
  };
  const slots = {
    imagesPerDay: 20,
    imagesPerVideo: 6,
    imagesToday: 1,
    imagesUsed: 1,
    slots: [{ assetId: "a1", candidates: [candidate], chosenId: null, history: [], prompt: "x" }],
  };

  it("list a plan's slots, draw, add and choose an image, each at its slot's path", async () => {
    handler = (request, response) => {
      const path = request.url ?? "";
      if (path.endsWith("/choice")) {
        json(response, 204, undefined);
      } else if (request.method === "GET") {
        json(response, 200, slots);
      } else {
        json(response, 201, candidate);
      }
    };
    const { director } = client();
    await expect(director.listAssets(caller, VIDEO)).resolves.toEqual(slots);
    const drawing = {
      baseId: null,
      demo: false,
      instruction: null,
      prompt: "A red umbrella on a white table",
      referenceKey: null,
    };
    await expect(director.drawAsset(caller, slot, drawing)).resolves.toEqual(candidate);
    const upload = {
      credit: null,
      fileId: "0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a71",
      objectKey: "files/0b6f1c9e-8d4a-4f3e-9a2b-1c2d3e4f5a71",
      origin: "upload" as const,
    };
    await expect(director.addAsset(caller, slot, upload)).resolves.toEqual(candidate);
    await expect(
      director.chooseAsset(caller, slot, { candidateId: candidate.id }),
    ).resolves.toBeUndefined();

    const base = `/v1/director/plans/${VIDEO}/assets`;
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${base}`,
      `POST ${base}/a1/drawings`,
      `POST ${base}/a1/images`,
      `POST ${base}/a1/choice`,
    ]);
    expect(JSON.parse(String(seen[1]?.body))).toMatchObject(drawing);
    expect(JSON.parse(String(seen[2]?.body))).toEqual(upload);
    expect(JSON.parse(String(seen[3]?.body))).toEqual({ candidateId: candidate.id });
  });

  it("throw the service's error when a choice is refused", async () => {
    handler = (_request, response) =>
      json(response, 404, failure("NOT_FOUND", 404, { params: {} }));
    const error = await failed(client().director.chooseAsset(caller, slot, { candidateId: null }));
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("a template of the member's own", () => {
  const brief = { messages: [], photos: [], text: "My morning coffee routine" };
  const shotPlan = {
    title: "Morning coffee",
    format: "Routine",
    summary: "Making a coffee, start to finish.",
    audio: "speech" as const,
    durationSeconds: 4,
    shots: [
      {
        kind: "video" as const,
        title: "The pour",
        purpose: "Show the coffee going in.",
        sourceStartSeconds: 0,
        sourceEndSeconds: 4,
        durationSeconds: 4,
        camera: "back" as const,
        scene: "A kitchen counter",
        sceneLandmark: null,
        framing: {
          shotSize: "close-up" as const,
          subject: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
          note: "The cup fills the frame.",
        },
        phoneAngle: { height: "chest" as const, pitch: -10, roll: 0, tolerance: 8 },
        pose: { description: "Hands at the cup.", keypoints: [] },
        script: [],
        steps: [{ atSeconds: 0, cameraMove: "static" as const, instruction: "Pour slowly." }],
      },
    ],
  };

  it("brainstorm, create and edit it, each on its own route", async () => {
    const reply = { questionsLeft: 2, ready: false, reply: "What do you drink it from?" };
    handler = (request, response) =>
      request.url === "/v1/director/brainstorm"
        ? json(response, 200, reply)
        : json(response, request.method === "POST" ? 201 : 200, plan);
    const { director } = client();
    await expect(director.brainstorm(caller, brief)).resolves.toEqual(reply);
    await expect(director.createTemplate(caller, brief)).resolves.toEqual(plan);
    await expect(
      director.editTemplate(caller, { videoId: VIDEO, plan: shotPlan }),
    ).resolves.toEqual(plan);
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/director/brainstorm",
      "POST /v1/director/created",
      "PUT /v1/director/created",
    ]);
    expect(JSON.parse(String(seen[0]?.body))).toEqual(brief);
    expect(JSON.parse(String(seen[2]?.body))).toMatchObject({ videoId: VIDEO });
  });

  it("revise the member's version from one instruction", async () => {
    const version = {
      gaps: [],
      notes: [],
      shots: [{ shot: 0, where: "On the balcony" }],
      skipped: [],
    };
    const revised = { summary: "Moved the first shot to the balcony.", version };
    handler = (_request, response) => json(response, 200, revised);
    const body = { instruction: "Film the first shot on my balcony", version };
    await expect(client().director.revise(caller, VIDEO, body)).resolves.toEqual(revised);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/v1/director/plans/${VIDEO}/revisions`,
    });
    expect(JSON.parse(String(seen[0]?.body))).toEqual(body);
  });
});

describe("the conversational editor", () => {
  it("asks the editor and returns its reply", async () => {
    const reply = {
      actions: [],
      choices: [],
      heard: "make it black and white",
      outcome: "applied",
      say: "Done: it's black and white now.",
    };
    handler = (_request, response) => json(response, 200, reply);
    const body = {
      audio: null,
      audioType: null,
      text: "make it black and white",
      videoId: VIDEO,
      state: { captions: "pop" as const, fixes: [], music: true, sound: true, shots: [] },
    };
    await expect(client().director.askEditor(caller, body)).resolves.toEqual(reply);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/director/editor-requests" });
    expect(JSON.parse(String(seen[0]?.body))).toEqual(body);
  });
});

describe("cutting a recorded attempt", () => {
  const mp4 = Buffer.from("\x00\x00\x00\x20ftypisom", "latin1");
  const request = {
    attemptId: take.id,
    contentType: "video/webm" as const,
    slices: [{ url: "https://storage.test/s/0", startMs: 0, durationMs: 10_000 }],
    startMs: 1_000,
    endMs: 4_000,
    pauses: [],
  };
  const answer =
    (headers: Record<string, string>) => (_: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, headers);
      response.end(mp4);
    };

  it("returns the take's bytes and where it was cut", async () => {
    handler = answer({
      "content-type": "video/mp4",
      "x-clip-start-ms": "750",
      "x-clip-end-ms": "4250",
    });
    const clip = await client().director.clip(caller, request);
    expect({ ...clip, video: Buffer.from(clip.video) }).toEqual({
      video: mp4,
      startMs: 750,
      endMs: 4_250,
    });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/director/clips" });
    expect(JSON.parse(String(seen[0]?.body))).toEqual(request);
  });

  it("refuses an answer that isn't an MP4 or doesn't say where it was cut", async () => {
    handler = answer({
      "content-type": "video/webm",
      "x-clip-start-ms": "0",
      "x-clip-end-ms": "1",
    });
    expect(await failed(client().director.clip(caller, request))).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    handler = answer({ "content-type": "video/mp4", "x-clip-start-ms": "0" });
    expect(await failed(client().director.clip(caller, request))).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("throws the service's error with its code", async () => {
    handler = (_request, response) =>
      json(response, 422, failure("RECORDING_CLIP_FAILED", 422, { params: {} }));
    const error = await failed(client().director.clip(caller, request));
    expect(error).toMatchObject({ status: 422, code: "RECORDING_CLIP_FAILED" });
  });
});

describe("Director's voice", () => {
  const wav = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1");
  const line = { text: "Take a small step to your left.", voice: "Puck" as const };

  it("returns the line the service spoke, as the WAV file's bytes", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(wav);
    };
    const audio = await client().director.speak(caller, line);
    expect(Buffer.from(audio)).toEqual(wav);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/director/speak" });
    expect(JSON.parse(String(seen[0]?.body))).toEqual(line);
  });

  it("refuses a successful answer that isn't a WAV file", async () => {
    handler = (_request, response) => json(response, 200, { audio: "base64" });
    const error = await failed(client().director.speak(caller, line));
    expect(error).toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
  });

  it("throws the service's error with its code", async () => {
    handler = (_request, response) =>
      json(response, 429, failure("AI_BUDGET_EXCEEDED", 429, { params: {} }));
    const error = await failed(client().director.speak(caller, line));
    expect(error).toMatchObject({ status: 429, code: "AI_BUDGET_EXCEEDED" });
  });
});
