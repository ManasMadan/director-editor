/**
 * YouTube Data API v3, as apps/api reads it (apps/api/src/modules/shorts/youtube.ts):
 * search, videos and commentThreads, answered from the mock catalog (./catalog.ts).
 */
import { type CatalogShort, search, shortOf } from "./catalog";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function videoResource(short: CatalogShort) {
  return {
    id: short.videoId,
    snippet: {
      title: short.title,
      channelTitle: short.channelTitle,
      publishedAt: short.publishedAt,
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${short.videoId}/hqdefault.jpg` } },
    },
    contentDetails: { duration: `PT${short.durationSeconds}S` },
    statistics: {
      viewCount: String(short.viewCount),
      likeCount: String(short.likeCount),
      commentCount: String(short.commentCount),
    },
  };
}

const COMMENTS = [
  "Trying this tonight, the steps are so clear.",
  "The transition at the end got me.",
  "Director made me film this in ten minutes lol",
  "Where is the top from?",
];

function comments(videoId: string) {
  const short = shortOf(videoId);
  return COMMENTS.map((text, index) => ({
    id: `${videoId}-c${index}`,
    snippet: {
      topLevelComment: {
        snippet: {
          authorDisplayName: `@viewer${index + 1}`,
          textOriginal: text,
          likeCount: Math.round(short.likeCount / (40 * (index + 1))),
          publishedAt: short.publishedAt,
        },
      },
    },
  }));
}

/** The response to a YouTube Data API read, by its path and query. */
export function youtube(path: string, query: URLSearchParams): { status: number; body: object } {
  if (path === "search") {
    const found = search(query.get("q") ?? "");
    return {
      status: 200,
      body: { items: found.map((short) => ({ id: { videoId: short.videoId } })) },
    };
  }
  if (path === "videos") {
    const ids = (query.get("id") ?? "").split(",").filter((id) => VIDEO_ID.test(id));
    return { status: 200, body: { items: ids.map((id) => videoResource(shortOf(id))) } };
  }
  if (path === "commentThreads") {
    return { status: 200, body: { items: comments(query.get("videoId") ?? "") } };
  }
  return { status: 404, body: { error: { code: 404, errors: [{ reason: "notFound" }] } } };
}
