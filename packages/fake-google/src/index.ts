/**
 * A local stand-in for the two Google APIs Director uses, so integration, e2e and fuzz
 * suites run the whole flow with no real keys: the Gemini API
 * (`/v1beta/models/<model>:generateContent`, ./gemini.ts) and YouTube Data API v3
 * (`/youtube/v3/...`, ./youtube.ts). Like the real ones it checks the key (Gemini's
 * `x-goog-api-key` header, YouTube's `key` parameter) and answers anything else with a
 * 404. What it answers is mock data; everything that asks it (the AI service's agents,
 * the API's YouTube client) runs as it would against Google. The running app and
 * `bun dev`/`bun dev:full` never start it: they use the real services, off until a real
 * key is set.
 *
 * Tests point the AI service at it with GOOGLE_BASE_URL and the API with YOUTUBE_API_URL
 * (both refused in production, which needs HTTPS).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import * as z from "zod";
import { answer, generateRequest, generateResponse, promptTokens, type SceneSteps } from "./gemini";
import { youtube } from "./youtube";

export interface FakeGoogleOptions {
  apiKey: string;
  port?: number;
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
  seen: SceneSteps,
  apiKey: string,
) {
  if (request.headers["x-goog-api-key"] !== apiKey) {
    return refuse(response, 400, "API_KEY_INVALID");
  }
  const raw = await body(request);
  const parsed = generateRequest.safeParse(JSON.parse(raw || "{}"));
  const args = parsed.success ? answer(parsed.data, seen) : null;
  if (!parsed.success || !args) {
    return refuse(response, 400, "INVALID_ARGUMENT");
  }
  return send(response, 200, generateResponse(model, args, promptTokens(parsed.data)));
}

export async function startFakeGoogle({ apiKey, port = 0 }: FakeGoogleOptions) {
  const seen: SceneSteps = new Map();
  const server = createServer((request, response) => {
    // A server's request always has its URL; node types it as maybe missing.
    const url = new URL(String(request.url), "http://fake-google.local");
    const asked = GEMINI.exec(url.pathname);
    if (asked && request.method === "POST") {
      gemini(request, response, String(asked[1]), seen, apiKey).catch(() =>
        refuse(response, 400, "INVALID_ARGUMENT"),
      );
      return;
    }
    const read = YOUTUBE.exec(url.pathname);
    if (read && request.method === "GET") {
      if (url.searchParams.get("key") !== apiKey) {
        return refuse(response, 400, "keyInvalid");
      }
      const { status, body: reply } = youtube(String(read[1]), url.searchParams);
      return send(response, status, reply);
    }
    refuse(response, 404, "notFound");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
