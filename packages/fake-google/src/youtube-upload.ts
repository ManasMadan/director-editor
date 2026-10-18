/**
 * YouTube Data API v3's resumable upload (`videos.insert`), as apps/api publishes a cut
 * (apps/api/src/modules/publish/youtube-upload.ts): a POST to
 * `/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with the video's
 * metadata opens a session, and one PUT of the whole file to the session's URL finishes
 * it, answered with the video resource.
 *
 * Like YouTube it needs an access token whose grant includes an upload scope, refuses a
 * Google account with no channel (here, any address starting `no-channel`), checks the
 * metadata, keeps every upload private until the app has passed Google's audit
 * (`audited`), whatever privacy was asked for. It refuses every upload while the
 * project's quota is spent (`quotaSpent`), and fails a session's file while it's
 * `broken`.
 */
import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { Answer, Grant } from "./oauth";

const UPLOAD_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];
const NO_ANGLE_BRACKETS = /^[^<>]*$/;

const metadataSchema = z.object({
  snippet: z.object({
    title: z.string().min(1).max(100).regex(NO_ANGLE_BRACKETS),
    description: z
      .string()
      .regex(NO_ANGLE_BRACKETS)
      .refine((text) => Buffer.byteLength(text) <= 5_000)
      .default(""),
    categoryId: z.string().optional(),
  }),
  status: z.object({
    privacyStatus: z.enum(["private", "unlisted", "public"]),
    selfDeclaredMadeForKids: z.boolean().optional(),
  }),
});
type Metadata = z.infer<typeof metadataSchema>;

/** A finished upload, for tests to check what reached YouTube. */
interface YouTubeUpload extends Metadata {
  id: string;
  email: string;
  contentType: string;
  bytes: number;
}

interface Session {
  grant: Grant;
  metadata: Metadata;
  length: number;
  contentType: string;
}

function refuse(status: number, reason: string): Answer {
  return {
    status,
    body: { error: { code: status, message: reason, errors: [{ reason, domain: "youtube" }] } },
  };
}

const videoId = () => randomBytes(8).toString("base64url").slice(0, 11);

/**
 * The video resource YouTube answers a finished upload with: private, whatever was asked
 * for, until the app is `audited`.
 */
function videoAnswer(upload: YouTubeUpload, audited: boolean): Answer {
  const privacyStatus = audited ? upload.status.privacyStatus : "private";
  return {
    status: 200,
    body: {
      kind: "youtube#video",
      id: upload.id,
      snippet: upload.snippet,
      status: { ...upload.status, privacyStatus, uploadStatus: "uploaded" },
    },
  };
}

/** Why YouTube won't take an upload from this account now, if it won't. */
function refusalOf(grant: Grant, quotaSpent: boolean): Answer | null {
  if (!grant.scopes.some((scope) => UPLOAD_SCOPES.includes(scope))) {
    return refuse(403, "insufficientPermissions");
  }
  if (grant.email.startsWith("no-channel")) {
    return refuse(401, "youtubeSignupRequired");
  }
  return quotaSpent ? refuse(403, "quotaExceeded") : null;
}

export function createYouTubeUploads({
  url,
  audited,
  quotaSpent,
  broken,
}: {
  url: () => string;
  audited: boolean;
  quotaSpent: () => boolean;
  broken: () => boolean;
}) {
  const sessions = new Map<string, Session>();
  const uploads: YouTubeUpload[] = [];

  return {
    uploads,

    /** Opens a resumable session; `body` is the metadata JSON. */
    start(
      query: URLSearchParams,
      headers: { length: string | undefined; contentType: string | undefined },
      grant: Grant | undefined,
      body: string,
    ): Answer {
      if (query.get("uploadType") !== "resumable") {
        return refuse(400, "badRequest");
      }
      if (!grant) {
        return refuse(401, "authError");
      }
      const refused = refusalOf(grant, quotaSpent());
      if (refused) {
        return refused;
      }
      const metadata = metadataSchema.safeParse(JSON.parse(body || "{}"));
      const length = Number(headers.length);
      if (!metadata.success || !(length > 0)) {
        return refuse(400, "invalidVideoMetadata");
      }
      const id = randomBytes(16).toString("hex");
      sessions.set(id, {
        grant,
        metadata: metadata.data,
        length,
        contentType: headers.contentType ?? "video/*",
      });
      return {
        status: 200,
        headers: {
          location: `${url()}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`,
        },
      };
    },

    /** The session's whole file, in one PUT. */
    finish(query: URLSearchParams, bytes: number): Answer {
      const id = query.get("upload_id") ?? "";
      const session = sessions.get(id);
      if (!session) {
        return refuse(404, "notFound");
      }
      if (broken()) {
        return refuse(503, "backendError");
      }
      if (bytes !== session.length) {
        return refuse(400, "uploadSizeMismatch");
      }
      sessions.delete(id);
      const upload: YouTubeUpload = {
        id: videoId(),
        email: session.grant.email,
        contentType: session.contentType,
        bytes,
        ...session.metadata,
      };
      uploads.push(upload);
      return videoAnswer(upload, audited);
    },
  };
}
