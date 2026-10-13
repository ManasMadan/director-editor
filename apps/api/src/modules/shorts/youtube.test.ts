/**
 * The YouTube client against a local stand-in for the Data API: what it makes of each
 * kind of video, page and comment YouTube sends, and of each way a call can fail.
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

function video(
  videoId: string,
  duration: string,
  thumbnails: Record<string, { url: string }> = {
    high: { url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` },
  },
  statistics: Record<string, string> | null = { viewCount: "10", likeCount: "2" },
) {
  return {
    id: videoId,
    snippet: {
      title: `Video ${videoId}`,
      channelTitle: "Creator",
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnails,
    },
    contentDetails: { duration },
    ...(statistics && { statistics }),
  };
}

const youtube = () => new YouTube({ baseUrl, apiKey: "key-1" });

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(YouTubeError);
  return error as YouTubeError;
}

describe("reading videos", () => {
  it("asks for nothing when there's nothing to ask for", async () => {
    await expect(youtube().videos([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the order asked for, and leaves out what isn't there or can't be shown", async () => {
    route = (_url, response) =>
      send(response, 200, {
        items: [
          video("Picture0004", "PT1M", { default: { url: "https://i.ytimg.com/d.jpg" } }),
          video("Days0000001", "P1DT1H1M1S", {
            maxres: { url: "https://i.ytimg.com/max.jpg" },
            high: { url: "https://i.ytimg.com/high.jpg" },
          }),
          video("Medium00003", "PT30S", { medium: { url: "https://i.ytimg.com/m.jpg" } }),
          video("NoStats0005", "PT5S", undefined, null),
          // A live stream (no length yet), a duration that isn't one, and no picture at all.
          video("LiveStream1", "P0D"),
          video("BadDuration", "about a minute"),
          video("NoPicture01", "PT20S", {}),
        ],
      });
    const asked = [
      "Days0000001",
      "Medium00003",
      "Picture0004",
      "NoStats0005",
      "LiveStream1",
      "BadDuration",
      "NoPicture01",
      "NotThere001",
    ].map(id);
    const shorts = await youtube().videos(asked);

    expect(
      shorts.map((short) => [short.videoId, short.durationSeconds, short.thumbnailUrl]),
    ).toEqual([
      ["Days0000001", 90_061, "https://i.ytimg.com/max.jpg"],
      ["Medium00003", 30, "https://i.ytimg.com/m.jpg"],
      ["Picture0004", 60, "https://i.ytimg.com/d.jpg"],
      ["NoStats0005", 5, "https://i.ytimg.com/vi/NoStats0005/hq.jpg"],
    ]);
    expect(shorts[0]).toMatchObject({
      title: "Video Days0000001",
      channelTitle: "Creator",
      viewCount: 10,
      likeCount: 2,
      commentCount: null,
      publishedAt: new Date("2026-09-01T10:00:00Z"),
    });
    expect(shorts[3]).toMatchObject({ viewCount: null, likeCount: null, commentCount: null });

    const [call] = calls;
    expect(call?.pathname).toBe("/videos");
    expect(call?.searchParams.get("id")).toBe(asked.join(","));
    expect(call?.searchParams.get("key")).toBe("key-1");
  });
});

describe("searching", () => {
  it("passes the page and order on, and keeps only what's short enough", async () => {
    route = (url, response) =>
      url.pathname === "/search"
        ? send(response, 200, {
            items: [{ id: { videoId: "Short000001" } }, { id: { videoId: "TooLong0001" } }],
          })
        : send(response, 200, {
            items: [video("Short000001", "PT59S"), video("TooLong0001", "PT3M1S")],
          });
    const page = await youtube().search("#dance", "page-3", "viewCount");
    expect(page).toEqual({
      items: [expect.objectContaining({ videoId: "Short000001" })],
      nextPageToken: null,
    });
    const search = calls[0]?.searchParams;
    expect(search?.get("q")).toBe("#dance");
    expect(search?.get("order")).toBe("viewCount");
    expect(search?.get("pageToken")).toBe("page-3");
    expect(search?.get("maxResults")).toBe("12");
  });
});

describe("reading comments", () => {
  it("reads the top comments, with the author's picture when there is one", async () => {
    const comment = (author: string, picture?: string) => ({
      id: `c-${author}`,
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: author,
            ...(picture && { authorProfileImageUrl: picture }),
            textOriginal: `From ${author}`,
            likeCount: "4",
            publishedAt: "2026-09-02T10:00:00Z",
          },
        },
      },
    });
    route = (_url, response) =>
      send(response, 200, {
        items: [comment("Fan", "https://yt3.ggpht.com/fan.jpg"), comment("Anon")],
      });
    await expect(youtube().comments(id("Short000001"))).resolves.toEqual({
      disabled: false,
      items: [
        {
          id: "c-Fan",
          author: "Fan",
          authorImageUrl: "https://yt3.ggpht.com/fan.jpg",
          text: "From Fan",
          likeCount: 4,
          publishedAt: new Date("2026-09-02T10:00:00Z"),
        },
        expect.objectContaining({ id: "c-Anon", authorImageUrl: null }),
      ],
    });
    expect(calls[0]?.searchParams.get("videoId")).toBe("Short000001");
  });

  it("says when the channel turned them off, and fails on anything else", async () => {
    route = (_url, response) =>
      send(response, 403, { error: { code: 403, errors: [{ reason: "commentsDisabled" }] } });
    await expect(youtube().comments(id("Short000001"))).resolves.toEqual({
      items: [],
      disabled: true,
    });

    route = (_url, response) =>
      send(response, 403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } });
    const error = await failure(youtube().comments(id("Short000001")));
    expect(error).toMatchObject({ status: 403, reason: "quotaExceeded" });
    expect(error.message).toBe("YouTube answered 403 quotaExceeded");
  });
});

describe("a call that fails", () => {
  it("carries YouTube's status, with a generic reason when it gave none", async () => {
    route = (_url, response) => send(response, 500, "<html>Backend Error</html>");
    expect(await failure(youtube().videos([id("Short000001")]))).toMatchObject({
      status: 500,
      reason: "error",
    });

    route = (_url, response) => send(response, 400, { error: { code: 400 } });
    expect(await failure(youtube().videos([id("Short000001")]))).toMatchObject({
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
    const error = await failure(unreachable.videos([id("Short000001")]));
    expect(error).toMatchObject({ status: 503, reason: "unreachable" });
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("fails loudly when an answer isn't in YouTube's format", async () => {
    route = (_url, response) => send(response, 200, { items: [{ id: "Short000001" }] });
    await expect(youtube().videos([id("Short000001")])).rejects.toBeInstanceOf(z.ZodError);
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
