/**
 * Publishing a cut (a member's finished video, in My media) to YouTube Shorts, from
 * their own Google account. Gemini drafts the copy (`copy`), the member edits it in the
 * publish sheet, and `upload` sends the video to their channel with it.
 *
 * The title and description YouTube gets are put together here, by `youtubeTitle` and
 * `youtubeDescription`, so the sheet previews exactly what the API sends: the title
 * carries #Shorts, and the description ends with the hashtags, the credits and the
 * original Short's link.
 */
import * as z from "zod";
import { directorCutIdSchema, type VideoId, videoIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";
import { directorCutSchema } from "./director";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_CUT_NOT_FOUND",
  "PUBLISH_DEMO_DISABLED",
  "PUBLISH_NEEDS_YOUTUBE",
  "PUBLISH_CUT_NOT_READY",
  "PUBLISH_NO_CHANNEL",
  "PUBLISH_QUOTA_EXHAUSTED",
);

/**
 * What Director asks Google for to upload to a member's YouTube channel: asked for when
 * they first publish (better-auth's linkSocial), not at sign-in.
 */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

/** Whether a Google account's granted scopes (better-auth joins them with commas) allow uploads. */
export const allowsUploads = (scope: string | null | undefined) =>
  (scope ?? "").split(/[\s,]+/).includes(YOUTUBE_UPLOAD_SCOPE);
/** What marks a video as a Short in its title. */
const SHORTS_TAG = "#Shorts";
/** YouTube's longest title, #Shorts included. */
const YOUTUBE_TITLE_MAX_LENGTH = 100;
export const PUBLISH_TITLE_MAX_LENGTH = YOUTUBE_TITLE_MAX_LENGTH - SHORTS_TAG.length - 1;
export const PUBLISH_DESCRIPTION_MAX_LENGTH = 3_000;
// The original's credit, then a line per stock picture the video uses.
const PUBLISH_CREDITS_MAX_LENGTH = 2_000;
const PUBLISH_HASHTAGS_MAX = 15;
const PUBLISH_HASHTAG_MAX_LENGTH = 40;
/** YouTube's longest description, in UTF-8 bytes. */
const YOUTUBE_DESCRIPTION_MAX_BYTES = 5_000;
/**
 * Videos Director publishes a day across every member, the day as YouTube's quota counts
 * it (midnight to midnight Pacific time): each upload costs a large share of the
 * project's daily YouTube Data API quota, which indexing's reads draw on too. Past it,
 * PUBLISH_QUOTA_EXHAUSTED until midnight Pacific time.
 */
export const PUBLISH_DAILY_LIMIT = 5;

// YouTube refuses a title or description with angle brackets in it (invalidTitle,
// invalidDescription).
const noAngleBrackets = /^[^<>]*$/;
// A hashtag is one word: letters, digits and underscores, in any script, without its #.
const hashtag = z
  .string()
  .trim()
  .min(1)
  .max(PUBLISH_HASHTAG_MAX_LENGTH)
  .regex(/^[\p{L}\p{N}\p{M}_]+$/u);

export const publishCopySchema = z.object({
  /** Without #Shorts: the API adds it (youtubeTitle). */
  title: z.string().trim().min(1).max(PUBLISH_TITLE_MAX_LENGTH).regex(noAngleBrackets),
  description: z.string().trim().max(PUBLISH_DESCRIPTION_MAX_LENGTH).regex(noAngleBrackets),
  /** Without their #. */
  hashtags: z.array(hashtag).max(PUBLISH_HASHTAGS_MAX),
  /** Who the original is by, and that it was recreated with Director. */
  credits: z.string().trim().max(PUBLISH_CREDITS_MAX_LENGTH).regex(noAngleBrackets),
});
export type PublishCopy = z.infer<typeof publishCopySchema>;

export const publishVisibilities = ["unlisted", "private", "public"] as const;
export type PublishVisibility = (typeof publishVisibilities)[number];

/** The title YouTube gets: the member's, with #Shorts unless it already has it. */
export function youtubeTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.toLowerCase().includes(SHORTS_TAG.toLowerCase())
    ? trimmed
    : `${trimmed} ${SHORTS_TAG}`;
}

/** The original Short's link, as the description ends with it. */
const shortLink = (videoId: VideoId) => `https://youtube.com/shorts/${videoId}`;

/**
 * The description YouTube gets: the member's text, then the hashtags, then the credits
 * and the original Short's link, each part after a blank line and empty ones left out.
 */
export function youtubeDescription(copy: Omit<PublishCopy, "title">, videoId: VideoId) {
  const tags = copy.hashtags.map((tag) => `#${tag}`).join(" ");
  const credits = [copy.credits.trim(), shortLink(videoId)].filter(Boolean).join("\n");
  return [copy.description.trim(), tags, credits].filter(Boolean).join("\n\n");
}

/** How many bytes of YouTube's description limit a description takes. */
export function descriptionBytes(description: string) {
  // UTF-8 by hand: this package runs anywhere (React Native included), without
  // TextEncoder's types. A code point takes one byte, plus one past each of these.
  const wider = [0x80, 0x800, 0x10000];
  let bytes = 0;
  for (const char of description) {
    const code = Number(char.codePointAt(0));
    bytes += 1 + wider.filter((limit) => code >= limit).length;
  }
  return bytes;
}

// The longest a link to a Short can be: what the input's check measures against, since
// the input names the cut, not the Short.
const LONGEST_LINK_ID = videoIdSchema.parse("x".repeat(11));

/**
 * Whether the description YouTube would get from this copy fits YouTube's limit in
 * bytes: the one check the API's input and the publish sheet both make.
 */
export const fitsYouTube = (copy: Omit<PublishCopy, "title">) =>
  descriptionBytes(youtubeDescription(copy, LONGEST_LINK_ID)) <= YOUTUBE_DESCRIPTION_MAX_BYTES;

export const publishContract = {
  /**
   * Gemini's draft of the YouTube copy for a cut of the caller's: a title, a
   * description and hashtags in the Short's language, and the credits to the original.
   */
  copy: base
    .errors(errors)
    .meta({
      rateLimit: { name: "publish-copy", points: 20, windowSeconds: HOUR_S, per: "user" },
    })
    .route({
      method: "POST",
      path: "/media/{cutId}/publish-copy",
      tags: ["Publish"],
      summary: "Draft the YouTube copy for a video",
    })
    .input(z.object({ cutId: directorCutIdSchema }))
    .output(publishCopySchema),
  /**
   * Publishes a cut of the caller's to their YouTube channel as a Short, with the copy
   * they settled on, and answers with the cut as it was published: `publish.visibility`
   * is what YouTube made it, which can be stricter than asked for (YouTube keeps every
   * upload from an app it hasn't audited private). The demo account can't publish
   * (PUBLISH_DEMO_DISABLED); without a Google account allowed to upload to YouTube it's
   * PUBLISH_NEEDS_YOUTUBE, which the client answers by asking for that and trying again.
   * Past PUBLISH_DAILY_LIMIT videos a day, or once YouTube says the project's quota is
   * spent, it's PUBLISH_QUOTA_EXHAUSTED. A cut that's published, or being published, is
   * answered as it is.
   */
  upload: base
    .errors(errors)
    .meta({
      // Each upload costs a large share of the project's daily YouTube quota.
      rateLimit: { name: "publish-upload", points: 5, windowSeconds: HOUR_S, per: "user" },
    })
    .route({
      method: "POST",
      path: "/media/{cutId}/publish",
      tags: ["Publish"],
      summary: "Publish a video to YouTube Shorts",
    })
    .input(
      publishCopySchema
        .extend({
          cutId: directorCutIdSchema,
          visibility: z.enum(publishVisibilities).default("unlisted"),
        })
        .refine(fitsYouTube, { path: ["description"], message: "too long for YouTube" }),
    )
    .output(directorCutSchema),
};
