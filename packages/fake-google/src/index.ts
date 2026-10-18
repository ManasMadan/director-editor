/**
 * A local stand-in for the Google APIs Director uses, so integration, e2e and fuzz
 * suites run the whole flow with no real keys: the Gemini API
 * (`/v1beta/models/<model>:generateContent`, ./gemini.ts), Gemini's Live API on Vertex AI
 * (a WebSocket at `LIVE_API_PATH`, ./live.ts), YouTube Data API v3's reads
 * (`/youtube/v3/...`, ./youtube.ts) and its resumable upload
 * (`/upload/youtube/v3/videos`, ./youtube-upload.ts), Vertex AI's generateContent for
 * Director's slower line (./chat.ts), and Google sign-in, whose access
 * tokens the upload takes (./oauth.ts). Like the real ones it checks the key (Gemini's
 * `x-goog-api-key` header, YouTube's `key` parameter) or the access token, and answers
 * anything else with a 404. What it answers is mock data; everything that asks it (the
 * AI service's agents, the API's YouTube client, publisher and Live relay, better-auth's
 * Google provider) runs as it would against Google. The running app and
 * `bun dev`/`bun dev:full` never start it: they use the real services, off until a real
 * key is set.
 *
 * Tests point the AI service at it with GOOGLE_BASE_URL and the API with YOUTUBE_API_URL
 * and LIVE_API_URL (all refused in production, which needs HTTPS and WSS).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buffer, text } from "node:stream/consumers";
import * as z from "zod";
import { CHAT_API_PATH, chatAnswer } from "./chat";
import { answer, generateRequest, generateResponse, promptTokens } from "./gemini";
import { createLive } from "./live";

export { LIVE_API_PATH } from "./live";

import { type Answer, createOAuth, type OAuth } from "./oauth";
import { youtube } from "./youtube";
import { createYouTubeUploads } from "./youtube-upload";

export interface FakeGoogleOptions {
  apiKey: string;
  port?: number;
  /**
   * Whether the app has passed Google's audit for the YouTube Data API: until it has,
   * YouTube keeps every upload private, whatever privacy was asked for.
   */
  youtubeAudited?: boolean;
  /** The bearer token the Live API takes (the API's GOOGLE_ACCESS_TOKEN); the key by default. */
  liveToken?: string;
}

const GEMINI = /^\/v1beta\/models\/([^/:]+):generateContent$/;
const YOUTUBE = /^\/youtube\/v3\/(\w+)$/;

function send(response: ServerResponse, status: number, body: object) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function refuse(response: ServerResponse, status: number, reason: string) {
  send(response, status, {
    error: { code: status, message: reason, status: reason, errors: [{ reason }] },
  });
}

function body(request: IncomingMessage): Promise<string> {
  return text(request);
}

async function gemini(
  request: IncomingMessage,
  response: ServerResponse,
  model: string,
  apiKey: string,
) {
  if (request.headers["x-goog-api-key"] !== apiKey) {
    return refuse(response, 400, "API_KEY_INVALID");
  }
  const raw = await body(request);
  const parsed = generateRequest.safeParse(JSON.parse(raw || "{}"));
  const args = parsed.success ? answer(parsed.data) : null;
  if (!parsed.success || !args) {
    return refuse(response, 400, "INVALID_ARGUMENT");
  }
  return send(response, 200, generateResponse(model, args, promptTokens(parsed.data)));
}

function reply(response: ServerResponse, { status, headers = {}, body: payload }: Answer) {
  if (payload === undefined) {
    response.writeHead(status, { ...headers, "content-length": 0 });
    response.end();
    return;
  }
  const json = JSON.stringify(payload);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

async function bytesOf(request: IncomingMessage) {
  return (await buffer(request)).length;
}

type Uploads = ReturnType<typeof createYouTubeUploads>;

/** Director's slower line (./chat.ts), with the Live API's bearer token; 503 while it's down. */
async function chat(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  down: boolean,
) {
  if (request.headers.authorization !== `Bearer ${token}`) {
    return refuse(response, 401, "UNAUTHENTICATED");
  }
  if (down) {
    return refuse(response, 503, "UNAVAILABLE");
  }
  const answered = chatAnswer(JSON.parse((await body(request)) || "{}"));
  return answered ? send(response, 200, answered) : refuse(response, 400, "INVALID_ARGUMENT");
}

/**
 * Gemini's generateContent, as the AI service's agents call it (the Gemini API) and as
 * the slower line does (Vertex AI); false for any other route.
 */
function modelRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: { apiKey: string; liveToken: string; trouble: { chatDown: boolean } },
): boolean {
  if (request.method !== "POST") {
    return false;
  }
  const failed = () => refuse(response, 400, "INVALID_ARGUMENT");
  if (CHAT_API_PATH.test(url.pathname)) {
    chat(request, response, context.liveToken, context.trouble.chatDown).catch(failed);
    return true;
  }
  const asked = GEMINI.exec(url.pathname);
  if (asked) {
    gemini(request, response, String(asked[1]), context.apiKey).catch(failed);
    return true;
  }
  return false;
}

/** Sign-in and the upload: the routes a Google account's access token is for. */
async function accountRoute(
  request: IncomingMessage,
  url: URL,
  { oauth, uploads }: { oauth: OAuth; uploads: Uploads },
): Promise<Answer | null> {
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /o/oauth2/v2/auth") {
    return oauth.authorize(url.searchParams);
  }
  if (route === "POST /token") {
    return oauth.token(new URLSearchParams(await body(request)));
  }
  if (route === "GET /oauth2/v3/certs") {
    return oauth.certs();
  }
  if (route === "POST /upload/youtube/v3/videos") {
    const header = (name: string) => z.string().optional().parse(request.headers[name]);
    return uploads.start(
      url.searchParams,
      { length: header("x-upload-content-length"), contentType: header("x-upload-content-type") },
      oauth.grantOf(request.headers.authorization),
      await body(request),
    );
  }
  if (route === "PUT /upload/youtube/v3/videos") {
    return uploads.finish(url.searchParams, await bytesOf(request));
  }
  return null;
}

export async function startFakeGoogle({
  apiKey,
  port = 0,
  youtubeAudited = false,
  liveToken = apiKey,
}: FakeGoogleOptions) {
  const oauth = createOAuth();
  // Known once the server listens; upload sessions link back to it.
  const address = { url: "" };
  // Whether the project's daily YouTube quota is spent, and whether YouTube fails the
  // files it's sent: a test says so (exhaustQuota, breakUploads).
  const trouble = { quotaSpent: false, uploadsBroken: false, chatDown: false };
  const uploads = createYouTubeUploads({
    url: () => address.url,
    audited: youtubeAudited,
    quotaSpent: () => trouble.quotaSpent,
    broken: () => trouble.uploadsBroken,
  });
  const server = createServer((request, response) => {
    // A server's request always has its URL; node types it as maybe missing.
    const url = new URL(String(request.url), "http://fake-google.local");
    if (modelRoute(request, response, url, { apiKey, liveToken, trouble })) {
      return;
    }
    const read = YOUTUBE.exec(url.pathname);
    if (read && request.method === "GET") {
      if (url.searchParams.get("key") !== apiKey) {
        return refuse(response, 400, "keyInvalid");
      }
      if (trouble.quotaSpent) {
        return refuse(response, 403, "quotaExceeded");
      }
      const found = youtube(String(read[1]), url.searchParams);
      return send(response, found.status, found.body);
    }
    accountRoute(request, url, { oauth, uploads }).then(
      (answered) => (answered ? reply(response, answered) : refuse(response, 404, "notFound")),
      () => refuse(response, 400, "badRequest"),
    );
  });
  const live = createLive({ accessToken: liveToken });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(String(request.url), "http://fake-google.local").pathname;
    if (!live.upgrade(request, socket, head, path)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = z.object({ port: z.number() }).parse(server.address());
  address.url = `http://127.0.0.1:${bound}`;
  return {
    url: address.url,
    /** Every video uploaded to the mock YouTube, oldest first. */
    uploads: uploads.uploads,
    /** Has YouTube refuse reads and uploads as over the project's quota, or stop. */
    exhaustQuota: (spent: boolean) => {
      trouble.quotaSpent = spent;
    },
    /** Has YouTube fail the file of every upload (a 503) once its session is open, or stop. */
    breakUploads: (broken: boolean) => {
      trouble.uploadsBroken = broken;
    },
    /** Has Director's slower line answer 503, as Gemini out of reach, or stop. */
    chatOutage: (down: boolean) => {
      trouble.chatDown = down;
    },
    /** Director live: each connection made to the Live API, and its warning that one closes soon. */
    live: { sessions: live.sessions, goAway: live.goAway },
    close: () =>
      new Promise<void>((resolve) => {
        live.close();
        server.close(() => resolve());
      }),
  };
}
