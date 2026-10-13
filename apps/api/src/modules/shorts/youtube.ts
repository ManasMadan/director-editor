/**
 * YouTube Data API v3, as Director reads it: searching shorts, a video's details, its
 * top comments. The only place that knows YouTube's wire format; every response is
 * parsed with a schema here, so a change on YouTube's side fails loudly instead of
 * passing bad data on.
 *
 * Swapping the source (another platform's API, a curated catalogue): implement the same
 * three reads and construct it in ShortsService.
 *
 * Quota: a search costs 100 units of the default 10,000 a day, the other reads 1 each,
 * so ShortsService caches what it reads.
 */
import type { Short, ShortComment } from "@repo/contracts/api";
import { SHORT_MAX_SECONDS, SHORTS_PAGE_SIZE } from "@repo/contracts/api";
import { type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import * as z from "zod";

const COMMENTS_PAGE = 20;

/** YouTube answered with an error (quota, a bad key, an outage) or not at all. */
export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`YouTube answered ${status} ${reason}`);
  }
}

const count = z.coerce.number().int().nonnegative();
const thumbnail = z.object({ url: z.url() });
const videoResource = z.object({
  id: videoIdSchema,
  snippet: z.object({
    title: z.string(),
    channelTitle: z.string(),
    publishedAt: z.coerce.date(),
    thumbnails: z.object({
      maxres: thumbnail.optional(),
      high: thumbnail.optional(),
      medium: thumbnail.optional(),
      default: thumbnail.optional(),
    }),
  }),
  contentDetails: z.object({ duration: z.string() }),
  statistics: z
    .object({
      viewCount: count.optional(),
      likeCount: count.optional(),
      commentCount: count.optional(),
    })
    .default({}),
});
const videosResponse = z.object({ items: z.array(videoResource) });
const searchResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.object({ id: z.object({ videoId: videoIdSchema }) })),
});
const commentsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        topLevelComment: z.object({
          snippet: z.object({
            authorDisplayName: z.string(),
            authorProfileImageUrl: z.url().optional(),
            textOriginal: z.string(),
            likeCount: count,
            publishedAt: z.coerce.date(),
          }),
        }),
      }),
    }),
  ),
});
const errorResponse = z.object({
  error: z.object({
    code: z.number(),
    errors: z.array(z.object({ reason: z.string() })).default([]),
  }),
});

/** An ISO 8601 duration ("PT1M5S") in whole seconds; null when it isn't one. */
function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) {
    return null;
  }
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0);
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * The video id in a link someone pasted: youtube.com/shorts/<id>, youtube.com/watch?v=<id>,
 * youtu.be/<id>, or the bare id. Null for anything else.
 */
export function videoIdFromLink(link: string): VideoId | null {
  const bare = videoIdSchema.safeParse(link.trim());
  if (bare.success) {
    return bare.data;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(link.trim()) ? link.trim() : `https://${link.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const [first, second] = url.pathname.split("/").filter(Boolean);
  let candidate: string | null | undefined = null;
  if (host === "youtu.be") {
    candidate = first;
  } else if (YOUTUBE_HOSTS.has(host)) {
    candidate = first === "shorts" || first === "embed" ? second : url.searchParams.get("v");
  }
  const parsed = videoIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function toShort(video: z.infer<typeof videoResource>): Short | null {
  const durationSeconds = parseDuration(video.contentDetails.duration);
  const thumbnails = video.snippet.thumbnails;
  const picture = thumbnails.maxres ?? thumbnails.high ?? thumbnails.medium ?? thumbnails.default;
  // A live stream has no duration and a video without a picture isn't one to show.
  if (durationSeconds === null || durationSeconds === 0 || !picture) {
    return null;
  }
  return {
    videoId: video.id,
    title: video.snippet.title,
    channelTitle: video.snippet.channelTitle,
    thumbnailUrl: picture.url,
    durationSeconds,
    viewCount: video.statistics.viewCount ?? null,
    likeCount: video.statistics.likeCount ?? null,
    commentCount: video.statistics.commentCount ?? null,
    publishedAt: video.snippet.publishedAt,
  };
}

type Comments = z.infer<typeof commentsResponse>["items"];

function toComments(items: Comments): ShortComment[] {
  return items.map(({ id, snippet }) => {
    const comment = snippet.topLevelComment.snippet;
    return {
      id,
      author: comment.authorDisplayName,
      authorImageUrl: comment.authorProfileImageUrl ?? null,
      text: comment.textOriginal,
      likeCount: comment.likeCount,
      publishedAt: comment.publishedAt,
    };
  });
}

export class YouTube {
  constructor(private readonly options: { baseUrl: string; apiKey: string }) {}

  private async read<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>) {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, "")}/${path}`);
    for (const [name, value] of Object.entries({ ...params, key: this.options.apiKey })) {
      url.searchParams.set(name, value);
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (cause) {
      throw Object.assign(new YouTubeError(503, "unreachable"), { cause });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = errorResponse.safeParse(body);
      const reason = parsed.success ? (parsed.data.error.errors[0]?.reason ?? "error") : "error";
      throw new YouTubeError(response.status, reason);
    }
    return schema.parse(body);
  }

  /** Videos by id, in the order asked for; ones that aren't (or are no longer) there are left out. */
  async videos(ids: VideoId[]): Promise<Short[]> {
    if (ids.length === 0) {
      return [];
    }
    const { items } = await this.read(
      "videos",
      { part: "snippet,contentDetails,statistics", id: ids.join(","), maxResults: "50" },
      videosResponse,
    );
    const found = new Map(items.map((item) => [item.id, toShort(item)]));
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  /** One page of shorts matching `query`; only videos short enough for Director. */
  async search(query: string, pageToken: string | undefined, order: "relevance" | "viewCount") {
    const page = await this.read(
      "search",
      {
        part: "id",
        type: "video",
        videoDuration: "short",
        safeSearch: "moderate",
        videoEmbeddable: "true",
        order,
        q: query,
        maxResults: String(SHORTS_PAGE_SIZE),
        ...(pageToken && { pageToken }),
      },
      searchResponse,
    );
    const items = await this.videos(page.items.map((item) => item.id.videoId));
    return {
      items: items.filter((short) => short.durationSeconds <= SHORT_MAX_SECONDS),
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  /** Its top comments; `disabled` when the channel turned them off. */
  async comments(videoId: VideoId): Promise<{ items: ShortComment[]; disabled: boolean }> {
    try {
      const { items } = await this.read(
        "commentThreads",
        {
          part: "snippet",
          videoId,
          order: "relevance",
          textFormat: "plainText",
          maxResults: String(COMMENTS_PAGE),
        },
        commentsResponse,
      );
      return { items: toComments(items), disabled: false };
    } catch (error) {
      if (error instanceof YouTubeError && error.reason === "commentsDisabled") {
        return { items: [], disabled: true };
      }
      throw error;
    }
  }
}
