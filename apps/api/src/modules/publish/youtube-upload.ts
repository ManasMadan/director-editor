/**
 * YouTube Data API v3's resumable upload (`videos.insert`), as Director publishes a cut:
 * one POST opens the session with the video's metadata, one PUT streams the whole file
 * to it, and YouTube answers with the video it made. The only place that knows YouTube's
 * upload wire format; its answer is parsed here, so a change on YouTube's side fails
 * loudly. The video is streamed through, never held in memory (a cut is up to 100 MB).
 *
 * Uploads are made with the member's own Google access token (their channel), never an
 * API key. YouTube keeps every upload from an app that hasn't passed its audit private,
 * whatever privacy was asked for, so the privacy YouTube answers with is what's real.
 */
import { MINUTE_MS, PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import * as z from "zod";

/** YouTube refused the upload (`reason` is its error reason) or couldn't be reached. */
export class YouTubeUploadError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`YouTube answered the upload with ${status} ${reason}`);
  }
}

export interface YouTubeVideo {
  title: string;
  description: string;
  privacyStatus: "private" | "unlisted" | "public";
}

interface UploadFile {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
}

const errorResponse = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).default([]) }),
});
const uploadedVideo = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  status: z.object({ privacyStatus: z.enum(["private", "unlisted", "public"]) }),
});
export type UploadedVideo = z.infer<typeof uploadedVideo>;

// Sending 100 MB from the VM takes well under this; past it, the upload has failed.
const UPLOAD_TIMEOUT_MS = 10 * MINUTE_MS;
// YouTube's category for people and blogs, where most Shorts sit.
const PEOPLE_AND_BLOGS = "22";

/** The upload endpoint beside a YouTube Data API base URL (…/youtube/v3). */
export function uploadUrlOf(apiUrl: string) {
  return `${apiUrl.replace(/\/youtube\/v3\/?$/, "")}/upload/youtube/v3/videos`;
}

async function refusal(response: Response) {
  const parsed = errorResponse.safeParse(await response.json().catch(() => null));
  const reason = parsed.success ? (parsed.data.error.errors[0]?.reason ?? "error") : "error";
  return new YouTubeUploadError(response.status, reason);
}

async function call(url: string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw Object.assign(new YouTubeUploadError(503, "unreachable"), { cause });
  }
}

export class YouTubeUploader {
  constructor(private readonly uploadUrl: string) {}

  /** Uploads `file` (its bytes as a stream, and how many) as the token's channel's video. */
  async upload(accessToken: string, video: YouTubeVideo, file: UploadFile): Promise<UploadedVideo> {
    let session: string;
    try {
      session = await this.start(accessToken, video, file);
    } catch (error) {
      // Nothing will read the file now: let storage's connection go.
      await file.body.cancel();
      throw error;
    }
    // Node's fetch sends a stream only with `duplex`, which the RequestInit type this
    // package reads fetch with doesn't list yet.
    const put: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: { "content-type": file.contentType, "content-length": String(file.size) },
      body: file.body,
      duplex: "half",
    };
    const finished = await call(session, put, UPLOAD_TIMEOUT_MS);
    if (!finished.ok) {
      throw await refusal(finished);
    }
    return uploadedVideo.parse(await finished.json());
  }

  /** Opens the upload session: the URL the file goes to. */
  private async start(accessToken: string, video: YouTubeVideo, file: UploadFile) {
    const url = new URL(this.uploadUrl);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");
    const started = await call(
      url.toString(),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-length": String(file.size),
          "x-upload-content-type": file.contentType,
        },
        body: JSON.stringify({
          snippet: {
            title: video.title,
            description: video.description,
            categoryId: PEOPLE_AND_BLOGS,
          },
          status: { privacyStatus: video.privacyStatus, selfDeclaredMadeForKids: false },
        }),
      },
      PROVIDER_TIMEOUT_MS,
    );
    const session = started.headers.get("location");
    if (!started.ok || !session) {
      throw await refusal(started);
    }
    return session;
  }
}
