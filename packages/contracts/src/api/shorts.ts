/**
 * The Shorts feed Director starts from: real YouTube shorts (YouTube Data API v3, read by
 * apps/api), the comments on one, and a member's likes and saves. Off (FEATURE_DISABLED)
 * until the API has a YouTube key.
 */
import * as z from "zod";
import { videoIdSchema } from "../ids";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "SHORT_NOT_FOUND",
);

/** Director films shorts: anything longer is refused (SHORT_TOO_LONG). */
export const SHORT_MAX_SECONDS = 180;
export const SHORTS_PAGE_SIZE = 12;
export const SAVED_SHORTS_LIMIT = 50;
export const SHORT_URL_MAX_LENGTH = 300;

/**
 * The feed's topic chips: each is a search of YouTube's shorts (the API holds the
 * queries). "all" is what's popular among shorts generally.
 */
export const shortTopics = [
  "all",
  "grwm",
  "outfits",
  "sneakers",
  "dance",
  "cooking",
  "travel",
  "comedy",
  "fitness",
  "pets",
] as const;
export type ShortTopic = (typeof shortTopics)[number];

export const shortSchema = z.object({
  videoId: videoIdSchema,
  title: z.string(),
  channelTitle: z.string(),
  thumbnailUrl: z.url(),
  durationSeconds: z.number().int().nonnegative(),
  /** Null when the channel hides them. */
  viewCount: z.number().int().nonnegative().nullable(),
  likeCount: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  publishedAt: z.date(),
});
export type Short = z.infer<typeof shortSchema>;

export const shortCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  authorImageUrl: z.url().nullable(),
  text: z.string(),
  likeCount: z.number().int().nonnegative(),
  publishedAt: z.date(),
});
export type ShortComment = z.infer<typeof shortCommentSchema>;

export const shortReactionKinds = ["like", "save"] as const;
export type ShortReactionKind = (typeof shortReactionKinds)[number];

const reactionsSchema = z.object({ liked: z.boolean(), saved: z.boolean() });
export type ShortReactions = z.infer<typeof reactionsSchema>;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Shorts"], summary });

export const shortsContract = {
  /** One page of shorts on a topic (each page costs YouTube quota, so they're cached). */
  feed: route("GET", "/shorts", "A page of YouTube shorts")
    .meta({ rateLimit: { name: "shorts-read", points: 120, windowSeconds: 60, per: "user" } })
    .input(
      z.object({
        topic: z.enum(shortTopics).default("all"),
        pageToken: z.string().max(200).optional(),
      }),
    )
    .output(z.object({ items: z.array(shortSchema), nextPageToken: z.string().nullable() })),
  get: route("GET", "/shorts/{videoId}", "One YouTube short")
    .meta({ rateLimit: { name: "shorts-read", points: 120, windowSeconds: 60, per: "user" } })
    .input(z.object({ videoId: videoIdSchema }))
    .output(shortSchema),
  /** A short from a link someone pasted (youtube.com/shorts/…, watch?v=…, youtu.be/…). */
  lookup: route("POST", "/shorts/lookup", "Find a short from its link")
    .meta({ rateLimit: { name: "shorts-lookup", points: 30, windowSeconds: 60, per: "user" } })
    .input(z.object({ url: z.string().trim().min(1).max(SHORT_URL_MAX_LENGTH) }))
    .output(shortSchema),
  /** Its top comments; `disabled` when the channel turned comments off. */
  comments: route("GET", "/shorts/{videoId}/comments", "A short's top comments")
    .meta({ rateLimit: { name: "shorts-read", points: 120, windowSeconds: 60, per: "user" } })
    .input(z.object({ videoId: videoIdSchema }))
    .output(z.object({ items: z.array(shortCommentSchema), disabled: z.boolean() })),
  /** Whether the caller liked or saved it (in this workspace). */
  reactions: route("GET", "/shorts/{videoId}/reactions", "Your like and save on a short")
    .input(z.object({ videoId: videoIdSchema }))
    .output(reactionsSchema),
  react: route("POST", "/shorts/{videoId}/reactions", "Like or save a short, or undo it")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ videoId: videoIdSchema, kind: z.enum(shortReactionKinds), on: z.boolean() }))
    .output(reactionsSchema),
  /** The caller's liked or saved shorts, newest first. */
  saved: route("GET", "/shorts/saved/{kind}", "Your liked or saved shorts")
    .meta({ rateLimit: { name: "shorts-read", points: 120, windowSeconds: 60, per: "user" } })
    .input(z.object({ kind: z.enum(shortReactionKinds) }))
    .output(z.array(shortSchema)),
};
