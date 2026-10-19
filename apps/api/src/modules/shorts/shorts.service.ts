/**
 * The shorts Director films, as YouTube describes them (./youtube.ts): whether a pasted
 * link is one it can index. What YouTube says about a video is cached in Redis for an
 * hour (YouTube's quota is small, and a video's length doesn't change); the data is
 * public, so the cache isn't per workspace.
 */
import { Injectable } from "@nestjs/common";
import { SHORT_MAX_SECONDS } from "@repo/contracts/api";
import { type VideoId, videoIdFromLink } from "@repo/contracts/ids";
import { HOUR_S } from "@repo/contracts/time";
import { AppError, CacheService, InjectRedis, type Redis } from "@repo/nest-common";
import type * as z from "zod";
import { env } from "../../env";
import {
  type Credit,
  creditSchema,
  type Video,
  videoSchema,
  YouTube,
  YouTubeError,
} from "./youtube";

const VIDEO_TTL_S = HOUR_S;

@Injectable()
export class ShortsService {
  private readonly youtube = env.YOUTUBE_API_KEY
    ? new YouTube({ baseUrl: env.YOUTUBE_API_URL, apiKey: env.YOUTUBE_API_KEY })
    : null;
  private readonly cache: CacheService;

  constructor(@InjectRedis() redis: Redis) {
    this.cache = new CacheService(redis, "shorts");
  }

  /**
   * The short a pasted link points at, when Director can film it: DIRECTOR_VIDEO_UNAVAILABLE
   * when the link isn't a YouTube video or YouTube won't show it (private, removed),
   * DIRECTOR_TOO_LONG past SHORT_MAX_SECONDS.
   */
  /** The video a pasted link names, without asking YouTube; null when it names none. */
  videoIdOf(link: string): VideoId | null {
    return videoIdFromLink(link);
  }

  async filmable(link: string): Promise<Video> {
    const videoId = videoIdFromLink(link);
    const video = videoId ? await this.video(videoId) : null;
    if (!video) {
      throw new AppError("DIRECTOR_VIDEO_UNAVAILABLE");
    }
    if (video.durationSeconds > SHORT_MAX_SECONDS) {
      throw new AppError("DIRECTOR_TOO_LONG", { params: { maxSeconds: SHORT_MAX_SECONDS } });
    }
    return video;
  }

  /**
   * The original's title and channel, for the credits of a cut published from it; null
   * when YouTube no longer shows it.
   */
  credit(videoId: VideoId): Promise<Credit | null> {
    return this.cached(`credit:${videoId}`, creditSchema, (youtube) => youtube.credit(videoId));
  }

  /** The video, from the cache when it's there and from YouTube otherwise. */
  private video(videoId: VideoId): Promise<Video | null> {
    return this.cached(`video:${videoId}`, videoSchema, (youtube) => youtube.video(videoId));
  }

  /** What YouTube says, from the cache when it's there; what isn't there isn't cached. */
  private async cached<T>(
    key: string,
    schema: z.ZodType<T>,
    read: (youtube: YouTube) => Promise<T | null>,
  ): Promise<T | null> {
    if (!this.youtube) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "director" } });
    }
    const cached = await this.cache.get(key, schema);
    if (cached) {
      return cached;
    }
    const value = await read(this.youtube).catch((error: unknown) => {
      if (error instanceof YouTubeError) {
        throw new AppError("UPSTREAM_UNAVAILABLE", {
          params: { service: "youtube" },
          cause: error,
        });
      }
      throw error;
    });
    if (value) {
      await this.cache.set(key, value, VIDEO_TTL_S);
    }
    return value;
  }
}
