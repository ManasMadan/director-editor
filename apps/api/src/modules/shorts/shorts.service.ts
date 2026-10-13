/**
 * The Shorts feed, read from YouTube (./youtube.ts) and cached in Redis: YouTube's quota
 * is small (a search is 100 of 10,000 units a day) and shorts don't change by the minute.
 * The data is public, so the cache isn't per workspace; likes and saves are.
 */
import { Injectable } from "@nestjs/common";
import {
  SAVED_SHORTS_LIMIT,
  SHORT_MAX_SECONDS,
  type Short,
  type ShortReactionKind,
  type ShortReactions,
  type ShortTopic,
  shortCommentSchema,
  shortSchema,
} from "@repo/contracts/api";
import type { OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { HOUR_S, MINUTE_S } from "@repo/contracts/time";
import { AppError, CacheService, InjectRedis, type Redis } from "@repo/nest-common";
import * as z from "zod";
import { env } from "../../env";
import { ShortsRepository } from "./shorts.repository";
import { videoIdFromLink, YouTube, YouTubeError } from "./youtube";

/**
 * What each topic chip searches for. "all" is the most watched shorts; the rest are the
 * trends Director is made for, by the words their creators tag them with.
 */
const TOPIC_QUERIES: Record<ShortTopic, string> = {
  all: "#shorts",
  grwm: "#grwm get ready with me #shorts",
  outfits: "#outfit fit check #shorts",
  sneakers: "#sneakers shoe check #shorts",
  dance: "#dance trend #shorts",
  cooking: "#cooking recipe #shorts",
  travel: "#travel #shorts",
  comedy: "#comedy skit #shorts",
  fitness: "#workout #fitness #shorts",
  pets: "#pets #dog #cat #shorts",
};

const FEED_TTL_S = 30 * MINUTE_S;
const VIDEO_TTL_S = HOUR_S;
const COMMENTS_TTL_S = 10 * MINUTE_S;

// Cached as JSON, where dates come back as strings.
const cachedShort = shortSchema.extend({ publishedAt: z.coerce.date() });
const cachedFeed = z.object({ items: z.array(cachedShort), nextPageToken: z.string().nullable() });
const cachedComments = z.object({
  items: z.array(shortCommentSchema.extend({ publishedAt: z.coerce.date() })),
  disabled: z.boolean(),
});

@Injectable()
export class ShortsService {
  private readonly youtube = env.YOUTUBE_API_KEY
    ? new YouTube({ baseUrl: env.YOUTUBE_API_URL, apiKey: env.YOUTUBE_API_KEY })
    : null;
  private readonly cache: CacheService;

  constructor(
    private readonly reactions: ShortsRepository,
    @InjectRedis() redis: Redis,
  ) {
    this.cache = new CacheService(redis, "shorts");
  }

  private get source() {
    if (!this.youtube) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "director" } });
    }
    return this.youtube;
  }

  private async call<T>(work: (youtube: YouTube) => Promise<T>): Promise<T> {
    const youtube = this.source;
    try {
      return await work(youtube);
    } catch (error) {
      if (error instanceof YouTubeError) {
        throw new AppError("UPSTREAM_UNAVAILABLE", {
          params: { service: "youtube" },
          cause: error,
        });
      }
      throw error;
    }
  }

  feed(topic: ShortTopic, pageToken: string | undefined) {
    return this.call((youtube) =>
      this.cache.wrap(`feed:${topic}:${pageToken ?? ""}`, FEED_TTL_S, cachedFeed, () =>
        youtube.search(
          TOPIC_QUERIES[topic],
          pageToken,
          topic === "all" ? "viewCount" : "relevance",
        ),
      ),
    );
  }

  /** One short (SHORT_NOT_FOUND when YouTube has no such video, or it can't be shown). */
  async get(videoId: VideoId): Promise<Short> {
    const [short] = await this.videos([videoId]);
    if (!short) {
      throw new AppError("SHORT_NOT_FOUND");
    }
    return short;
  }

  /** A short Director can film (SHORT_TOO_LONG past SHORT_MAX_SECONDS). */
  async filmable(videoId: VideoId): Promise<Short> {
    const short = await this.get(videoId);
    if (short.durationSeconds > SHORT_MAX_SECONDS) {
      throw new AppError("SHORT_TOO_LONG", { params: { maxSeconds: SHORT_MAX_SECONDS } });
    }
    return short;
  }

  lookup(link: string) {
    const videoId = videoIdFromLink(link);
    if (!videoId) {
      throw new AppError("SHORT_NOT_FOUND");
    }
    return this.get(videoId);
  }

  comments(videoId: VideoId) {
    return this.call((youtube) =>
      this.cache.wrap(`comments:${videoId}`, COMMENTS_TTL_S, cachedComments, () =>
        youtube.comments(videoId),
      ),
    );
  }

  async reactionsOf(orgId: OrgId, userId: UserId, videoId: VideoId): Promise<ShortReactions> {
    const kinds = await this.reactions.kinds(orgId, userId, videoId);
    return { liked: kinds.has("like"), saved: kinds.has("save") };
  }

  async react(
    orgId: OrgId,
    userId: UserId,
    input: { videoId: VideoId; kind: ShortReactionKind; on: boolean },
  ) {
    await this.reactions.set(orgId, userId, input.videoId, input.kind, input.on);
    return this.reactionsOf(orgId, userId, input.videoId);
  }

  async saved(orgId: OrgId, userId: UserId, kind: ShortReactionKind) {
    const ids = await this.reactions.videos(orgId, userId, kind, SAVED_SHORTS_LIMIT);
    return this.videos(ids);
  }

  /**
   * Videos by id, from the cache where it has them and from YouTube (one request) for
   * the rest; ones YouTube no longer has are left out.
   */
  private videos(ids: VideoId[]): Promise<Short[]> {
    return this.call(async (youtube) => {
      const cached = await Promise.all(ids.map((id) => this.cache.get(`video:${id}`, cachedShort)));
      const missing = ids.filter((_, index) => cached[index] === undefined);
      const fetched = new Map(
        (await youtube.videos(missing)).map((short) => [short.videoId, short]),
      );
      await Promise.all(
        [...fetched.values()].map((short) =>
          this.cache.set(`video:${short.videoId}`, short, VIDEO_TTL_S),
        ),
      );
      return ids.flatMap((id, index) => cached[index] ?? fetched.get(id) ?? []);
    });
  }
}
