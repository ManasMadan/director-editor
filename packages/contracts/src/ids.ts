/**
 * Branded ids: one type per kind of id, so passing a workspace's id where a user's
 * belongs, or swapping `(orgId, userId)`, is a compile error instead of a query that
 * quietly finds nothing (or the wrong rows).
 *
 * Every id is a UUID string at run time; the brand exists only for the compiler. A
 * branded id is still a string, so it goes anywhere a string does (Prisma, logs, URLs),
 * but a plain string never passes as one: it has to come through its schema here, which
 * checks it is a UUID. That happens once, where the id enters the code:
 *
 *   - API input and output: the contract's schemas use these, so a handler's input and a
 *     client's response carry the brand;
 *   - queue payloads and events: `parseJob` parses them through the same schemas;
 *   - better-auth's users, sessions and organizations: the API's auth adapter
 *     (apps/api/src/auth/ids.ts);
 *   - a database row, which Prisma types as a plain string: `orgIdSchema.parse(row.orgId)`
 *     where the code hands it on.
 *
 * Never cast a string to one of these: parse it.
 */
import * as z from "zod";

export const orgIdSchema = z.uuid().brand<"OrgId">();
export type OrgId = z.infer<typeof orgIdSchema>;

export const userIdSchema = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof userIdSchema>;

export const todoIdSchema = z.uuid().brand<"TodoId">();
export type TodoId = z.infer<typeof todoIdSchema>;

export const fileIdSchema = z.uuid().brand<"FileId">();
export type FileId = z.infer<typeof fileIdSchema>;

export const directorPlanIdSchema = z.uuid().brand<"DirectorPlanId">();

export const directorTakeIdSchema = z.uuid().brand<"DirectorTakeId">();
export type DirectorTakeId = z.infer<typeof directorTakeIdSchema>;

export const directorCutIdSchema = z.uuid().brand<"DirectorCutId">();
export type DirectorCutId = z.infer<typeof directorCutIdSchema>;

export const recordingSessionIdSchema = z.uuid().brand<"RecordingSessionId">();
export type RecordingSessionId = z.infer<typeof recordingSessionIdSchema>;

export const recordingAttemptIdSchema = z.uuid().brand<"RecordingAttemptId">();
export type RecordingAttemptId = z.infer<typeof recordingAttemptIdSchema>;

/** A YouTube video id: 11 characters of URL-safe base64. */
export const videoIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{11}$/)
  .brand<"VideoId">();
export type VideoId = z.infer<typeof videoIdSchema>;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * The video id in a link someone pasted: youtube.com/shorts/<id>, youtube.com/watch?v=<id>,
 * youtu.be/<id>, or the bare id. Null for anything else. The API reads links with it, and
 * the web checks one with it before sending it, so a word or another site's link is
 * answered at once, in its own words, rather than as a video YouTube doesn't have.
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

// The ids of features Director removed, kept for the events that still name them
// (packages/contracts events.ts).
export const apiKeyIdSchema = z.uuid().brand<"ApiKeyId">();

export const webhookEndpointIdSchema = z.uuid().brand<"WebhookEndpointId">();
