/**
 * YouTube Data API v3, as Director reads it: whether a video is there and how long it
 * is, before a short is indexed, and its title and channel, which a published cut
 * credits. The only place that knows YouTube's wire format; every
 * response is parsed with a schema here, so a change on YouTube's side fails loudly
 * instead of passing bad data on.
 *
 * Swapping the source (another platform's API): implement the same read and construct
 * it in ShortsService.
 *
 * Quota: a read costs 1 unit of the default 10,000 a day; ShortsService caches them.
 */
import { type VideoId, videoIdSchema } from "@repo/contracts/ids";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import * as z from "zod";

/** YouTube answered with an error (quota, a bad key, an outage) or not at all. */
export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`YouTube answered ${status} ${reason}`);
  }
}

const videoResource = z.object({
  id: videoIdSchema,
  contentDetails: z.object({ duration: z.string() }),
});
const videosResponse = z.object({ items: z.array(videoResource) });
const snippetsResponse = z.object({
  items: z.array(
    z.object({
      id: videoIdSchema,
      snippet: z.object({ title: z.string(), channelTitle: z.string() }),
    }),
  ),
});
const errorResponse = z.object({
  error: z.object({
    code: z.number(),
    errors: z.array(z.object({ reason: z.string() })).default([]),
  }),
});

/** A video YouTube shows, as far as Director needs to know before indexing it. */
export const videoSchema = z.object({
  videoId: videoIdSchema,
  durationSeconds: z.number().int().positive(),
});
export type Video = z.infer<typeof videoSchema>;

/** Who made a video and what it's called, as YouTube shows them. */
export const creditSchema = z.object({ title: z.string(), channel: z.string() });
export type Credit = z.infer<typeof creditSchema>;

/** An ISO 8601 duration ("PT1M5S") in whole seconds; null when it isn't one. */
function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) {
    return null;
  }
  // Days, hours, minutes and seconds are groups 1 to 4; one that's left out is 0.
  const part = (group: number) => Number(match[group] ?? 0);
  return ((part(1) * 24 + part(2)) * 60 + part(3)) * 60 + part(4);
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

function toVideo(video: z.infer<typeof videoResource>): Video | null {
  const durationSeconds = parseDuration(video.contentDetails.duration);
  // A live stream has no duration yet: nothing to film along to.
  if (durationSeconds === null || durationSeconds === 0) {
    return null;
  }
  return { videoId: video.id, durationSeconds };
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

  /** The video, or null when it isn't (or is no longer) there, or can't be filmed along to. */
  async video(id: VideoId): Promise<Video | null> {
    const { items } = await this.read(
      "videos",
      { part: "contentDetails", id, maxResults: "1" },
      videosResponse,
    );
    const found = items.find((item) => item.id === id);
    return found ? toVideo(found) : null;
  }

  /** The video's title and channel, or null when it isn't (or is no longer) there. */
  async credit(id: VideoId): Promise<Credit | null> {
    const { items } = await this.read("videos", { part: "snippet", id }, snippetsResponse);
    const found = items.find((item) => item.id === id);
    return found ? { title: found.snippet.title, channel: found.snippet.channelTitle } : null;
  }
}
