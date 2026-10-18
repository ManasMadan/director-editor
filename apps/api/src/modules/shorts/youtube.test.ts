/**
 * The YouTube client against a local stand-in for the Data API: what it makes of each
 * kind of video YouTube sends, and of each way a call can fail.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { videoIdFromLink, YouTube, YouTubeError } from "./youtube";

type Route = (url: URL, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let route: Route;
const calls: URL[] = [];

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", "http://youtube.test");
    calls.push(url);
    route(url, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  calls.length = 0;
});

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

const id = (value: string): VideoId => videoIdSchema.parse(value);

function video(videoId: string, duration: string) {
  return { id: videoId, contentDetails: { duration } };
}

const youtube = () => new YouTube({ baseUrl, apiKey: "key-1" });

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(YouTubeError);
  return error as YouTubeError;
}

describe("reading a video", () => {
  it.each([
    ["PT1M", 60],
    ["PT30S", 30],
    ["P1DT1H1M1S", 90_061],
  ])("reads how long it is (%s)", async (duration, seconds) => {
    route = (_url, response) => send(response, 200, { items: [video("Short000001", duration)] });
    await expect(youtube().video(id("Short000001"))).resolves.toEqual({
      videoId: "Short000001",
      durationSeconds: seconds,
    });
    const [call] = calls;
    expect(call?.pathname).toBe("/videos");
    expect(call?.searchParams.get("id")).toBe("Short000001");
    expect(call?.searchParams.get("part")).toBe("contentDetails");
    expect(call?.searchParams.get("key")).toBe("key-1");
  });

  it("is nothing when YouTube doesn't have it, or it can't be filmed along to", async () => {
    route = (_url, response) => send(response, 200, { items: [] });
    await expect(youtube().video(id("NotThere001"))).resolves.toBeNull();
    // A live stream (no length yet), and a duration that isn't one.
    for (const duration of ["P0D", "about a minute"]) {
      route = (_url, response) => send(response, 200, { items: [video("Short000001", duration)] });
      await expect(youtube().video(id("Short000001"))).resolves.toBeNull();
    }
    // Another video than the one asked for isn't it.
    route = (_url, response) => send(response, 200, { items: [video("Another0001", "PT9S")] });
    await expect(youtube().video(id("Short000001"))).resolves.toBeNull();
  });
});

describe("a call that fails", () => {
  it("carries YouTube's status and reason", async () => {
    route = (_url, response) =>
      send(response, 403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } });
    const error = await failure(youtube().video(id("Short000001")));
    expect(error).toMatchObject({ status: 403, reason: "quotaExceeded" });
    expect(error.message).toBe("YouTube answered 403 quotaExceeded");
  });

  it("carries YouTube's status, with a generic reason when it gave none", async () => {
    route = (_url, response) => send(response, 500, "<html>Backend Error</html>");
    expect(await failure(youtube().video(id("Short000001")))).toMatchObject({
      status: 500,
      reason: "error",
    });

    route = (_url, response) => send(response, 400, { error: { code: 400 } });
    expect(await failure(youtube().video(id("Short000001")))).toMatchObject({
      status: 400,
      reason: "error",
    });
  });

  it("is a 503 when YouTube can't be reached", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const unreachable = new YouTube({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "key-1" });
    const error = await failure(unreachable.video(id("Short000001")));
    expect(error).toMatchObject({ status: 503, reason: "unreachable" });
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("fails loudly when an answer isn't in YouTube's format", async () => {
    route = (_url, response) => send(response, 200, { items: [{ id: "Short000001" }] });
    await expect(youtube().video(id("Short000001"))).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe("a pasted link", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://www.youtube.com/shorts/dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
    ["HTTPS://M.YOUTUBE.COM/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=dQw4w9WgXcQ&t=10", "dQw4w9WgXcQ"],
    ["http://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
  ])("finds the video in %s", (link, expected) => {
    expect(videoIdFromLink(link)).toBe(expected);
  });

  it.each([
    ["not a link at all"],
    ["https://example.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch"],
    ["https://youtu.be/"],
    ["https://www.youtube.com/shorts/too-short"],
  ])("finds nothing in %s", (link) => {
    expect(videoIdFromLink(link)).toBeNull();
  });
});
