/**
 * The YouTube uploader against a local stand-in for YouTube's upload endpoint: what it
 * sends, and what it makes of each way an upload can fail. The whole publish, against
 * the mock Google, is in test/publish.integration.test.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadUrlOf, YouTubeUploadError, YouTubeUploader } from "./youtube-upload";

type Route = (request: IncomingMessage, response: ServerResponse, body: Buffer) => void;

let server: Server;
let baseUrl: string;
let route: Route;
const received: { method: string; headers: IncomingMessage["headers"]; body: Buffer }[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    received.push({ method: String(request.method), headers: request.headers, body });
    route(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function send(response: ServerResponse, status: number, body?: unknown, location?: string) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(location && { location }),
  });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

const BYTES = Buffer.from("a cut's bytes");
const file = () => ({
  body: new Blob([BYTES]).stream(),
  size: BYTES.length,
  contentType: "video/mp4",
});
const video = { title: "My look #Shorts", description: "Mine.", privacyStatus: "public" as const };
const uploader = () => new YouTubeUploader(`${baseUrl}/upload/youtube/v3/videos`);

/** YouTube opening a session, then answering the PUT with `finish`. */
function session(finish: (response: ServerResponse) => void): Route {
  return (request, response) => {
    if (request.method === "POST") {
      return send(response, 200, undefined, `${baseUrl}/session-1`);
    }
    finish(response);
  };
}

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => expect.fail("expected the upload to fail"),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(YouTubeUploadError);
  return error;
}

describe("the YouTube uploader", () => {
  it("opens a resumable session with the metadata, then streams the file to it", async () => {
    received.length = 0;
    route = session((response) =>
      send(response, 200, { id: "AbCdEfGhIjK", status: { privacyStatus: "private" } }),
    );
    await expect(uploader().upload("token-1", video, file())).resolves.toEqual({
      id: "AbCdEfGhIjK",
      status: { privacyStatus: "private" },
    });
    const [start, put] = received;
    expect(start?.headers).toMatchObject({
      authorization: "Bearer token-1",
      "x-upload-content-length": String(BYTES.length),
      "x-upload-content-type": "video/mp4",
    });
    expect(JSON.parse(String(start?.body))).toEqual({
      snippet: { title: video.title, description: video.description, categoryId: "22" },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
    });
    expect(put?.headers["content-length"]).toBe(String(BYTES.length));
    expect(put?.body).toEqual(BYTES);
  });

  it("declares a video with AI footage as altered or synthetic content", async () => {
    received.length = 0;
    route = session((response) =>
      send(response, 200, { id: "AbCdEfGhIjK", status: { privacyStatus: "private" } }),
    );
    await uploader().upload("token-1", { ...video, containsSyntheticMedia: true }, file());
    const [start] = received;
    expect(JSON.parse(String(start?.body)).status).toMatchObject({
      containsSyntheticMedia: true,
    });
  });

  it("says why YouTube refused to open the session, and lets go of the file", async () => {
    route = (_request, response) =>
      send(response, 403, { error: { errors: [{ reason: "quotaExceeded" }] } });
    const upload = file();
    const error = await refusal(uploader().upload("token", video, upload));
    expect(error).toMatchObject({ status: 403, reason: "quotaExceeded", sessionOpened: false });
    // Cancelled: nothing can read it any more.
    expect(upload.body.locked).toBe(false);
    await expect(upload.body.getReader().read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("calls an answer it can't read, or a session without its link, an error", async () => {
    route = (_request, response) => send(response, 500);
    expect(await refusal(uploader().upload("token", video, file()))).toMatchObject({
      status: 500,
      reason: "error",
    });
    route = (_request, response) => send(response, 200, { error: {} });
    expect(await refusal(uploader().upload("token", video, file()))).toMatchObject({
      status: 200,
      reason: "error",
    });
  });

  it("says why YouTube refused the file itself", async () => {
    route = session((response) =>
      send(response, 400, { error: { errors: [{ reason: "uploadSizeMismatch" }] } }),
    );
    expect(await refusal(uploader().upload("token", video, file()))).toMatchObject({
      status: 400,
      reason: "uploadSizeMismatch",
      // Past the session: the insert counts against the quota already.
      sessionOpened: true,
    });
  });

  it("says when the file couldn't be sent once the session was open", async () => {
    route = (_request, response) => send(response, 200, undefined, "http://127.0.0.1:1/session");
    expect(await refusal(uploader().upload("token", video, file()))).toMatchObject({
      status: 503,
      reason: "unreachable",
      sessionOpened: true,
    });
  });

  it("says YouTube can't be reached when nothing answers", async () => {
    const closed = new YouTubeUploader("http://127.0.0.1:1/upload/youtube/v3/videos");
    expect(await refusal(closed.upload("token", video, file()))).toMatchObject({
      status: 503,
      reason: "unreachable",
      sessionOpened: false,
    });
  });
});

describe("the upload endpoint", () => {
  it("sits beside the Data API's base URL", () => {
    expect(uploadUrlOf("https://www.googleapis.com/youtube/v3")).toBe(
      "https://www.googleapis.com/upload/youtube/v3/videos",
    );
    expect(uploadUrlOf("http://127.0.0.1:12112/youtube/v3/")).toBe(
      "http://127.0.0.1:12112/upload/youtube/v3/videos",
    );
  });
});
