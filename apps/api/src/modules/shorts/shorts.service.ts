/**
 * The shorts Director films, as YouTube describes them (./youtube.ts): whether a pasted
 * link is one it can index. What YouTube says about a video is cached in Redis for an
 * hour (YouTube's quota is small, and a video's length doesn't change); the data is
 * public, so the cache isn't per workspace.
 */
import { Injectable } from "@nestjs/common";
import { SHORT_MAX_SECONDS } from "@repo/contracts/api";
import type { VideoId } from "@repo/contracts/ids";
import { HOUR_S } from "@repo/contracts/time";
import { AppError, CacheService, InjectRedis, type Redis } from "@repo/nest-common";
import { env } from "../../env";
import { type Video, videoIdFromLink, videoSchema, YouTube, YouTubeError } from "./youtube";

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

  /** The video, from the cache when it's there and from YouTube otherwise. */
  private async video(videoId: VideoId): Promise<Video | null> {
    if (!this.youtube) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "director" } });
    }
    const cached = await this.cache.get(`video:${videoId}`, videoSchema);
    if (cached) {
      return cached;
    }
    const video = await this.youtube.video(videoId).catch((error: unknown) => {
      if (error instanceof YouTubeError) {
        throw new AppError("UPSTREAM_UNAVAILABLE", {
          params: { service: "youtube" },
          cause: error,
        });
      }
      throw error;
    });
    if (video) {
      await this.cache.set(`video:${videoId}`, video, VIDEO_TTL_S);
    }
    return video;
  }
}
