/**
 * The live call, end to end inside this process: a browser's socket to /api/live on a
 * bare Fastify server, the relay, and a stand-in for Vertex AI's Live API that speaks its
 * JSON over a real WebSocket. Who calls, the plan and the token are stand-ins too.
 */
import { type IncomingHttpHeaders, IncomingMessage } from "node:http";
import { type AddressInfo, connect, Socket } from "node:net";
import { Duplex } from "node:stream";
import { type DirectorPlan, directorPlanSchema, type Shot } from "@repo/contracts/api";
import { orgIdSchema, userIdSchema } from "@repo/contracts/ids";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { AppError } from "@repo/nest-common";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import * as z from "zod";
import type { OrgCaller } from "../../rpc/procedures";
import type { GoogleAuth } from "./google-auth";
import { LIVE_PATH, type LiveOptions, liveUpstream, MAX_CALL_MS, mountLive } from "./live.gateway";
import { CLIENT_MAX_PAYLOAD_BYTES } from "./live.messages";
import { LIVE_TOOLS, systemInstruction } from "./live.setup";

const shot: Shot = {
  kind: "video",
  title: "The pour",
  purpose: "Open on the coffee.",
  sourceStartSeconds: 0,
  sourceEndSeconds: 3,
  durationSeconds: 3,
  camera: "back",
  scene: "At a kitchen counter, near a window",
  sceneLandmark: "mug",
  framing: {
    shotSize: "close-up",
    subject: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    note: "The mug in the middle.",
  },
  phoneAngle: { pitch: -20, roll: 0, tolerance: 10, height: "chest" },
  pose: { description: "One hand pouring", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Pour slowly", cameraMove: "static" }],
  script: [{ startSeconds: 0, endSeconds: 3, text: "Good morning, coffee first!" }],
};

const readyPlan: DirectorPlan = directorPlanSchema.parse({
  id: "7d3c1c4e-8a52-4f0a-9d76-0f1f7b8b2a11",
  videoId: "dQw4w9WgXcQ",
  status: "ready",
  error: null,
  plan: {
    title: "Morning coffee",
    format: "GRWM",
    summary: "Making coffee before work.",
    audio: "speech",
    durationSeconds: 6,
    shots: [shot, { ...shot, title: "The sip", steps: [], script: [] }],
  },
  model: "gemini",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const caller: OrgCaller = {
  orgId: orgIdSchema.parse("0b9f5c1e-3f4a-4c55-8f0e-2a6d1c7e9b10"),
  userId: userIdSchema.parse("5e2d7c3a-1b4f-4a8e-9c6d-7f0a2b3c4d5e"),
  role: "member",
  apiKeyId: null,
  signedInAt: new Date(0),
};

const WEB = "http://localhost:3000";
const json = (data: RawData) => z.record(z.string(), z.unknown()).parse(JSON.parse(String(data)));

/** A stand-in for the Live API: answers setup, records what arrives, sends what it's told. */
class FakeLiveApi {
  readonly server: WebSocketServer;
  readonly listening: Promise<void>;
  readonly received: Record<string, unknown>[] = [];
  socket: WebSocket | null = null;
  headers: IncomingHttpHeaders = {};
  /** Connections asked for, including ones still held at the handshake. */
  attempts = 0;
  answerSetup = true;

  constructor(options: { holdHandshake?: Promise<void> } = {}) {
    this.server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (_info, done) => {
        this.attempts += 1;
        void (options.holdHandshake ?? Promise.resolve()).then(() => done(true));
      },
    });
    this.listening = new Promise((resolve) => this.server.once("listening", resolve));
    this.server.on("connection", (socket, request) => {
      this.socket = socket;
      this.headers = request.headers;
      socket.on("message", (data) => {
        const message = json(data);
        this.received.push(message);
        if ("setup" in message && this.answerSetup) {
          socket.send(Buffer.from(JSON.stringify({ setupComplete: {} })));
        }
      });
    });
  }

  get url() {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/ws`;
  }

  send(message: unknown) {
    this.socket?.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Waits for the nth message (0-based) that reached it. */
  async message(index: number) {
    await vi.waitFor(() => expect(this.received.length).toBeGreaterThan(index));
    return this.received[index];
  }

  close() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** The browser's side of a call. */
class Browser {
  readonly received: Record<string, unknown>[] = [];
  readonly closed: Promise<number>;
  readonly opened: Promise<void>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.received.push(json(data)));
    this.closed = new Promise((resolve) => socket.on("close", (code) => resolve(code)));
    this.opened = new Promise((resolve) => socket.on("open", () => resolve()));
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  async message(index: number) {
    await vi.waitFor(() => expect(this.received.length).toBeGreaterThan(index));
    return this.received[index];
  }
}

const tokenAuth: GoogleAuth = { accessToken: () => Promise.resolve("test-token") };
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startApi(overrides: Partial<LiveOptions> = {}, fake = new FakeLiveApi()) {
  await fake.listening;
  const app: FastifyInstance = Fastify();
  servers.push(fake);
  const log = vi.fn<LiveOptions["log"]>();
  let clock = 0;
  mountLive(app, {
    allowedOrigins: [`${WEB}/`],
    caller: () => Promise.resolve(caller),
    plan: () => Promise.resolve(readyPlan),
    spendCallLimit: () => Promise.resolve(),
    upstream: {
      model: { project: "p", location: "l", model: "m" },
      url: fake.url,
      auth: tokenAuth,
    },
    log,
    now: () => clock,
    ...overrides,
  });
  app.get("/plain", () => Promise.resolve("plain answer"));
  await app.listen({ port: 0, host: "127.0.0.1" });
  servers.push(app);
  const { port } = app.server.address() as AddressInfo;
  const call = (query = "videoId=dQw4w9WgXcQ&shot=0", headers: Record<string, string> = {}) =>
    new Browser(
      new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}?${query}`, {
        headers: { origin: WEB, ...headers },
      }),
    );
  // A client that isn't a browser sends no Origin at all.
  const callWithoutOrigin = () =>
    new Browser(new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}?videoId=dQw4w9WgXcQ&shot=0`));
  /** Waits for the API's side of every browser socket to close, as the relay sees it. */
  const hungUp = () =>
    vi.waitFor(async () => {
      const open = await new Promise<number>((resolve) =>
        app.server.getConnections((_error, count) => resolve(count)),
      );
      expect(open).toBe(0);
    });
  const tick = (ms: number) => {
    clock += ms;
  };
  return { app, fake, log, call, callWithoutOrigin, port, hungUp, tick };
}

/**
 * An upgrade request over a raw socket, answered with what the server writes first; with
 * `reset`, the client then resets the connection instead of closing it.
 */
function rawUpgrade(
  port: number,
  path: string,
  protocol: string,
  origin = WEB,
  options: { reset?: boolean } = {},
) {
  return new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: ${protocol}\r\n\r\n`,
      ),
    );
    socket.once("data", (data) => {
      if (options.reset) {
        socket.resetAndDestroy();
      } else {
        socket.end();
      }
      resolve(String(data));
    });
  });
}

/** A call that Gemini has its setup for, and has greeted. */
async function liveCall(overrides: Partial<LiveOptions> = {}) {
  const api = await startApi(overrides);
  const browser = api.call();
  await api.fake.message(1); // setup, then the greeting
  return { ...api, browser };
}

describe("a live call", () => {
  it("opens Gemini on the caller's token with the shot's script and the five tools", async () => {
    const { fake } = await liveCall();
    expect(fake.headers.authorization).toBe("Bearer test-token");
    const { setup } = (await fake.message(0)) as { setup: Record<string, unknown> };
    expect(setup).toMatchObject({
      model: "projects/p/locations/l/publishers/google/models/m",
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
    });
    const text = JSON.stringify(setup.systemInstruction);
    expect(text).toContain("Good morning, coffee first!");
    expect(text).toContain("At a kitchen counter, near a window");
    expect(text).toContain("Shot 1 of 2: The pour");
    const tools = setup.tools as { functionDeclarations: { name: string }[] }[];
    expect(tools[0]?.functionDeclarations.map((tool) => tool.name)).toEqual([...LIVE_TOOLS]);
    expect(await fake.message(1)).toMatchObject({ clientContent: { turnComplete: true } });
  });

  it("forwards the microphone, typed text, and at most one camera frame a second", async () => {
    const { fake, browser, tick } = await liveCall();
    browser.send({ type: "audio", pcm16: "AAAAAA==" });
    browser.send({ type: "frame", jpeg: "/9j/4AAQ" });
    browser.send({ type: "frame", jpeg: "/9j/dropped=" });
    browser.send({ type: "text", text: "I'm ready" });
    expect(await fake.message(2)).toEqual({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AAAAAA==" } },
    });
    expect(await fake.message(3)).toEqual({
      realtimeInput: { video: { mimeType: "image/jpeg", data: "/9j/4AAQ" } },
    });
    expect(await fake.message(4)).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "I'm ready" }] }],
        turnComplete: true,
      },
    });
    tick(1000);
    browser.send({ type: "frame", jpeg: "/9j/next" });
    expect(await fake.message(5)).toMatchObject({ realtimeInput: { video: { data: "/9j/next" } } });
  });

  it("plays the director's voice and both transcripts, and says when it was cut off", async () => {
    const { fake, browser } = await liveCall();
    fake.send({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: "BBBB" } },
            { text: "x" },
          ],
        },
        inputTranscription: { text: "Is this right?" },
        outputTranscription: { text: "Lovely, hold it there." },
      },
    });
    fake.send({ serverContent: { interrupted: true, modelTurn: {} } });
    expect(await browser.message(0)).toEqual({ type: "audio", pcm16: "BBBB" });
    expect(await browser.message(1)).toEqual({
      type: "transcript",
      who: "you",
      text: "Is this right?",
    });
    expect(await browser.message(2)).toEqual({
      type: "transcript",
      who: "director",
      text: "Lovely, hold it there.",
    });
    expect(await browser.message(3)).toEqual({ type: "interrupted" });
  });

  it("hands the director's tool calls to the browser, and tells Gemini they were done", async () => {
    const { fake, browser, log } = await liveCall();
    fake.send({
      toolCall: {
        functionCalls: [
          { id: "1", name: "start_recording", args: { reason: "ready" } },
          { id: "2", name: "next_shot" },
          { id: "3", name: "delete_everything", args: {} },
        ],
      },
    });
    fake.send({ toolCall: {} });
    expect(await browser.message(0)).toEqual({
      type: "tool",
      name: "start_recording",
      args: { reason: "ready" },
    });
    expect(await browser.message(1)).toEqual({ type: "tool", name: "next_shot", args: {} });
    expect(await fake.message(2)).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "1", name: "start_recording", response: { result: "done" } },
          { id: "2", name: "next_shot", response: { result: "done" } },
          { id: "3", name: "delete_everything", response: { error: "unknown tool" } },
        ],
      },
    });
    expect(log).toHaveBeenCalledWith(
      "warn",
      { tool: "delete_everything" },
      "unknown live tool call",
    );
  });

  it("cuts a long reason short rather than refusing the tool", async () => {
    const { fake, browser } = await liveCall();
    const reason = "r".repeat(600);
    fake.send({ toolCall: { functionCalls: [{ id: "1", name: "retake", args: { reason } }] } });
    expect(await browser.message(0)).toEqual({
      type: "tool",
      name: "retake",
      args: { reason: "r".repeat(500) },
    });
    expect(await fake.message(2)).toMatchObject({
      toolResponse: { functionResponses: [{ id: "1", response: { result: "done" } }] },
    });
  });

  it("forwards up to twice real time of microphone audio, and hangs up past it", async () => {
    const { fake, browser, tick } = await liveCall();
    // 66,000 bytes of audio each: four fit in five seconds' budget of 320,000, five don't.
    const chunk = { type: "audio", pcm16: "A".repeat(88_000) };
    for (let sent = 0; sent < 4; sent++) {
      browser.send(chunk);
    }
    await fake.message(5);
    tick(5000);
    for (let sent = 0; sent < 5; sent++) {
      browser.send(chunk);
    }
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code: "RATE_LIMITED" }]);
    await vi.waitFor(() => expect(fake.server.clients.size).toBe(0));
    expect(fake.received).toHaveLength(10);
  });

  it("takes three typed turns in ten seconds, and hangs up on a fourth", async () => {
    const { fake, browser } = await liveCall();
    for (const text of ["one", "two", "three", "four"]) {
      browser.send({ type: "text", text });
    }
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code: "RATE_LIMITED" }]);
    await vi.waitFor(() => expect(fake.server.clients.size).toBe(0));
    expect(fake.received).toHaveLength(5);
  });

  it("hangs up when Gemini stops reading what it's sent", async () => {
    let clock = 0;
    // Every frame a second after the last, so none is dropped for coming too soon.
    const { fake, browser, log } = await liveCall({ now: () => (clock += 1000) });
    fake.socket?.pause();
    const frame = { type: "frame", jpeg: "A".repeat(300_000) };
    for (let sent = 0; sent < 80 && browser.socket.readyState === WebSocket.OPEN; sent++) {
      // One at a time, as each leaves: the API reads them as fast as they come.
      await new Promise<void>((resolve) =>
        browser.socket.send(JSON.stringify(frame), () => resolve()),
      );
    }
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toContainEqual({ type: "error", code: "UPSTREAM_UNAVAILABLE" });
    expect(log).toHaveBeenCalledWith("warn", expect.anything(), "live upstream fell behind");
    // Its end of the socket never reads the close either; drop it so the stand-in can stop.
    fake.socket?.terminate();
  });

  it("hangs up when Gemini never answers its setup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeLiveApi();
    fake.answerSetup = false;
    const { call, log } = await startApi({}, fake);
    const browser = call();
    await fake.message(0);
    vi.advanceTimersByTime(PROVIDER_TIMEOUT_MS);
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(log).toHaveBeenCalledWith("error", {}, "live setup never completed");
  });

  it("skips what it can't read from Gemini and carries on", async () => {
    const { fake, browser, log } = await liveCall();
    fake.send("not json");
    fake.send({ serverContent: { interrupted: "yes" } });
    fake.send({ serverContent: { interrupted: true } });
    expect(await browser.message(0)).toEqual({ type: "interrupted" });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("warn", expect.anything(), "unreadable live message");
  });

  it("tells the browser and hangs up when Gemini closes", async () => {
    const { fake, browser, log } = await liveCall();
    fake.socket?.close(1008, "model not found");
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(log).toHaveBeenCalledWith(
      "error",
      { code: 1008, reason: "model not found" },
      "live upstream closed",
    );
  });

  it("tells the browser and hangs up when there is no token", async () => {
    const auth: GoogleAuth = { accessToken: () => Promise.reject(new Error("no metadata")) };
    const { fake, call, log } = await startApi({
      upstream: { model: { project: "p", location: "l", model: "m" }, url: "ws://unused", auth },
    });
    const browser = call();
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(log).toHaveBeenCalledWith("error", expect.anything(), "no Google access token");
    expect(fake.socket).toBeNull();
  });

  it("never opens Gemini for a browser that left while the token was fetched", async () => {
    const token = Promise.withResolvers<string>();
    const asked = Promise.withResolvers<void>();
    const auth: GoogleAuth = {
      accessToken: () => {
        asked.resolve();
        return token.promise;
      },
    };
    const fake = new FakeLiveApi();
    await fake.listening;
    const model = { project: "p", location: "l", model: "m" };
    const api = await startApi({ upstream: { model, url: fake.url, auth } }, fake);
    const browser = api.call();
    await Promise.all([browser.opened, asked.promise]);
    browser.socket.close();
    await api.hungUp();
    token.resolve("late-token");
    // The slot is free again, and only the next call reaches Gemini.
    const next = api.call();
    await fake.message(1);
    expect(fake.attempts).toBe(1);
    next.socket.close();
    await next.closed;
    expect(api.log).not.toHaveBeenCalled();
  });

  it("tells the browser and hangs up when Gemini can't be reached", async () => {
    const unreachable = new FakeLiveApi();
    await unreachable.listening;
    const url = unreachable.url;
    await unreachable.close();
    const { call, log } = await startApi({
      upstream: { model: { project: "p", location: "l", model: "m" }, url, auth: tokenAuth },
    });
    const browser = call();
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(log).toHaveBeenCalledWith("error", expect.anything(), "live upstream failed");
  });

  it("hangs up on Gemini when the browser does", async () => {
    const { fake, browser } = await liveCall();
    const upstreamClosed = new Promise((resolve) => fake.socket?.on("close", resolve));
    browser.socket.close();
    await upstreamClosed;
  });

  it("hangs up on Gemini when the browser leaves before Gemini answers", async () => {
    const handshake = Promise.withResolvers<void>();
    const api = await startApi({}, new FakeLiveApi({ holdHandshake: handshake.promise }));
    const browser = api.call();
    await vi.waitFor(() => expect(api.fake.attempts).toBe(1));
    browser.socket.close();
    await api.hungUp();
    handshake.resolve();
    // The next call starts: the first one let go of its slot without an error to log.
    const next = api.call();
    await vi.waitFor(() => expect(api.fake.attempts).toBe(2));
    next.socket.close();
    await next.closed;
    expect(api.log).not.toHaveBeenCalled();
  });

  it("ends after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { browser } = await liveCall();
    vi.advanceTimersByTime(MAX_CALL_MS - 1);
    expect(browser.received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code: "TIMEOUT" }]);
  });

  it("ignores the browser until Gemini is ready, and hangs up on a message it can't read", async () => {
    const fake = new FakeLiveApi();
    fake.answerSetup = false;
    const { call } = await startApi({}, fake);
    const browser = call();
    await fake.message(0);
    browser.send({ type: "audio", pcm16: "AAAAAA==" });
    browser.send({ type: "dance" });
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
    expect(fake.received).toHaveLength(1);
  });

  it.each([
    ["binary", Buffer.from([1, 2, 3])],
    ["not JSON", "{"],
  ])("refuses a %s message", async (_, data) => {
    const { browser } = await liveCall();
    browser.socket.send(data);
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
  });

  it("drops a message too large to be a frame", async () => {
    const { browser, log } = await liveCall();
    browser.socket.send("x".repeat(CLIENT_MAX_PAYLOAD_BYTES + 1));
    expect(await browser.closed).toBe(1009);
    expect(log).toHaveBeenCalledWith("warn", expect.anything(), "live client socket failed");
  });

  it("ends open calls when the server stops", async () => {
    const { app, browser } = await liveCall();
    await app.close();
    expect(await browser.closed).toBe(1006);
  });
});

describe("starting a call", () => {
  it.each([
    ["the feature is off", { upstream: null }, "FEATURE_DISABLED"],
    [
      "the caller isn't signed in",
      { caller: () => Promise.reject(new AppError("UNAUTHENTICATED")) },
      "UNAUTHENTICATED",
    ],
    [
      "the caller is out of calls",
      {
        spendCallLimit: () =>
          Promise.reject(new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 60 } })),
      },
      "RATE_LIMITED",
    ],
    [
      "the plan isn't asked for",
      { plan: () => Promise.reject(new AppError("DIRECTOR_PLAN_NOT_FOUND")) },
      "DIRECTOR_PLAN_NOT_FOUND",
    ],
    [
      "the plan isn't ready",
      { plan: () => Promise.resolve({ ...readyPlan, status: "analyzing" as const, plan: null }) },
      "DIRECTOR_PLAN_NOT_FOUND",
    ],
  ] satisfies [string, Partial<LiveOptions>, string][])(
    "is refused when %s",
    async (_, overrides, code) => {
      const { call, fake } = await startApi(overrides);
      const browser = call();
      expect(await browser.closed).toBe(1008);
      expect(browser.received).toEqual([{ type: "error", code }]);
      expect(fake.socket).toBeNull();
    },
  );

  it.each([
    ["a shot the plan doesn't have", "videoId=dQw4w9WgXcQ&shot=2", "DIRECTOR_SHOT_NOT_FOUND"],
    ["a malformed video", "videoId=nope&shot=0", "VALIDATION_FAILED"],
    ["no shot", "videoId=dQw4w9WgXcQ", "VALIDATION_FAILED"],
  ])("is refused for %s", async (_, query, code) => {
    const { call } = await startApi();
    const browser = call(query);
    expect(await browser.closed).toBe(1008);
    expect(browser.received).toEqual([{ type: "error", code }]);
  });

  it("refuses a second call while the first is open, and allows one after", async () => {
    const { call, fake, browser } = await liveCall();
    const second = call();
    expect(await second.closed).toBe(1008);
    expect(second.received).toEqual([{ type: "error", code: "CONFLICT" }]);
    browser.socket.close();
    await browser.closed;
    await vi.waitFor(() => expect(fake.server.clients.size).toBe(0));
    const third = call();
    await fake.message(3); // its setup and greeting, after the first call's two
    third.socket.close();
  });

  it("says our side failed, and logs why, when loading the plan breaks", async () => {
    const failure = new Error("database on fire");
    const { call, log } = await startApi({ plan: () => Promise.reject(failure) });
    const browser = call();
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "INTERNAL" }]);
    expect(log).toHaveBeenCalledWith("error", expect.anything(), "live call failed to start");
  });

  it("passes on an upstream failure's code, and logs it", async () => {
    const { call, log } = await startApi({
      plan: () => Promise.reject(new AppError("UPSTREAM_UNAVAILABLE")),
    });
    const browser = call();
    expect(await browser.closed).toBe(1011);
    expect(browser.received).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("does nothing more for a browser that left while the plan loaded", async () => {
    const loaded = Promise.withResolvers<DirectorPlan>();
    const broke = Promise.withResolvers<DirectorPlan>();
    const plan = vi
      .fn<LiveOptions["plan"]>()
      .mockReturnValueOnce(loaded.promise)
      .mockReturnValueOnce(broke.promise);
    const { call, fake, log } = await startApi({ plan });
    for (const finish of [
      () => loaded.resolve(readyPlan),
      () => broke.reject(new Error("too late")),
    ]) {
      const browser = call();
      await browser.opened;
      browser.socket.close();
      await browser.closed;
      finish();
    }
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(fake.socket).toBeNull();
  });

  it("refuses an upgrade from another site, or to another path", async () => {
    const { port, call } = await startApi();
    const refused = (browser: Browser) =>
      new Promise<number>((resolve) =>
        browser.socket.on("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        ),
      );
    const foreign = call(undefined, { origin: "https://evil.example" });
    foreign.socket.on("error", () => undefined);
    expect(await refused(foreign)).toBe(403);
    const elsewhere = new Browser(new WebSocket(`ws://127.0.0.1:${port}/api/other`));
    elsewhere.socket.on("error", () => undefined);
    expect(await refused(elsewhere)).toBe(404);
  });

  it("leaves other paths' upgrade requests to the server's own routes", async () => {
    const { port } = await startApi();
    const answer = await rawUpgrade(port, "/plain", "h2c");
    expect(answer).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(answer).toContain("plain answer");
  });

  it("keeps serving after a client resets its connection on a refused upgrade", async () => {
    const { port, call, fake } = await startApi();
    for (const [path, origin] of [
      [LIVE_PATH, "https://evil.example"],
      ["/plain", WEB],
    ] as const) {
      await rawUpgrade(port, path, "websocket", origin, { reset: true });
    }
    const browser = call();
    await fake.message(1);
    browser.socket.close();
  });

  it("refuses another path on a Node that sends every upgrade to the listener", async () => {
    const { app, log } = await startApi();
    const request = new IncomingMessage(new Socket());
    request.url = "/api/other";
    const written: string[] = [];
    const socket = new Duplex({
      read: () => undefined,
      write: (chunk, _encoding, done) => {
        written.push(String(chunk));
        done();
      },
    });
    const closed = new Promise((resolve) => socket.on("close", resolve));
    app.server.emit("upgrade", request, socket, Buffer.alloc(0));
    // The client resets meanwhile: logged, not thrown at the process.
    socket.emit("error", new Error("read ECONNRESET"));
    await closed;
    expect(written.join("")).toMatch(/^HTTP\/1\.1 404 Not Found/);
    expect(log).toHaveBeenCalledWith("warn", expect.anything(), "live upgrade socket failed");
  });

  it("charges the hourly limit only for a call that can start", async () => {
    const spendCallLimit = vi.fn<LiveOptions["spendCallLimit"]>(() => Promise.resolve());
    const notReady = { ...readyPlan, status: "analyzing" as const, plan: null };
    const { call } = await startApi({ spendCallLimit, plan: () => Promise.resolve(notReady) });
    await call().closed;
    expect(spendCallLimit).not.toHaveBeenCalled();
  });

  it("is open to a client that sends no origin (not a browser)", async () => {
    const { callWithoutOrigin, fake } = await startApi();
    const client = callWithoutOrigin();
    await fake.message(1);
    client.socket.close();
  });
});

describe("the call's configuration", () => {
  it("is off without a Google Cloud project, and names the region's endpoint", () => {
    const settings = { location: "europe-west4", model: "m", auth: tokenAuth };
    expect(liveUpstream({ ...settings, project: undefined })).toBeNull();
    expect(liveUpstream({ ...settings, project: "proj" })).toEqual({
      model: { project: "proj", location: "europe-west4", model: "m" },
      url: "wss://europe-west4-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent",
      auth: tokenAuth,
    });
  });

  it("describes a shot with nothing to say or do, and refuses one the plan doesn't have", () => {
    const plan = readyPlan.plan;
    expect(plan).not.toBeNull();
    if (plan) {
      const text = systemInstruction(plan, 1);
      expect(text).toContain("Shot 2 of 2: The sip");
      expect(text).toContain("nothing is said in this shot");
      expect(() => systemInstruction(plan, 2)).toThrow(RangeError);
    }
  });
});
