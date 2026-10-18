/**
 * YouTube Data API v3, as apps/api reads it (apps/api/src/modules/shorts/youtube.ts):
 * videos, answered from the mock catalog (./catalog.ts).
 */
import { type CatalogShort, shortOf } from "./catalog";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Ids of videos YouTube no longer shows (removed, or made private): left out of reads. */
const GONE = /^Gone/;

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

/** The response to a YouTube Data API read, by its path and query. */
export function youtube(path: string, query: URLSearchParams): { status: number; body: object } {
  if (path === "videos") {
    const ids = (query.get("id") ?? "")
      .split(",")
      .filter((id) => VIDEO_ID.test(id) && !GONE.test(id));
    return { status: 200, body: { items: ids.map((id) => videoResource(shortOf(id))) } };
  }
  return { status: 404, body: { error: { code: 404, errors: [{ reason: "notFound" }] } } };
}
