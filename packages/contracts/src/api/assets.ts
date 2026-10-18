/**
 * The asset picker: every asset slot of a Director plan (a chart, a headline card, an end
 * card...) offers the member three sources beside its default image, and remembers which
 * one their video uses.
 *
 * - Create with AI: an image drawn from a prompt (the slot's `prompt` is filled in from
 *   the original's reference), from a photo of theirs, or an edit of another of the
 *   slot's images by a sentence. Drawn in the background (a `director.changed` realtime
 *   nudge says when it lands), proofread for its text, within the member's limits: 12
 *   images a video (5 for the demo) and 30 a day (DIRECTOR_IMAGE_LIMIT past them).
 * - Upload: a ready `director-asset-image` upload of theirs (the files pipeline checks
 *   and normalises it).
 * - Stock: Pexels and Pixabay photos, searched here and copied into storage when used,
 *   each with its creator's credit, which publishing puts in the YouTube description.
 *   Off (FEATURE_DISABLED, the `stock` feature) without a provider's key.
 *
 * A member's own images are theirs alone; the default is the workspace's.
 */
import * as z from "zod";
import { fileIdSchema, videoIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";

const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "AI_BUDGET_EXCEEDED",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_IMAGE_LIMIT",
  "DIRECTOR_ASSET_NOT_FOUND",
  "FILE_NOT_FOUND",
  "FILE_NOT_READY",
);

/** The prompt a member may write for an image, and an edit's sentence. */
export const ASSET_PROMPT_MAX_LENGTH = 2_000;
export const ASSET_INSTRUCTION_MAX_LENGTH = 500;
const STOCK_QUERY_MAX_LENGTH = 100;
/** Results per provider for one stock search. */
export const STOCK_RESULTS_PER_PROVIDER = 12;

const assetIdSchema = z
  .string()
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const imageIdSchema = z.uuid();
const imageStatus = z.enum(["making", "ready", "failed"]);
const stockProviders = ["pexels", "pixabay"] as const;
export type StockProviderName = (typeof stockProviders)[number];

/** Who made a stock photo, and where it's from (credited when it's published). */
const stockCreditSchema = z.object({
  provider: z.enum(stockProviders),
  author: z.string().min(1).max(200),
  authorUrl: z.url(),
  pageUrl: z.url(),
});
export type StockCredit = z.infer<typeof stockCreditSchema>;

/** One of the member's own images for a slot. */
const assetImageSchema = z.object({
  id: imageIdSchema,
  origin: z.enum(["created", "upload", "stock"]),
  /** A still, or a clip (a gap's Veo clip: AI footage, flagged as synthetic on publish). */
  media: z.enum(["image", "video"]),
  /** `making` while it's drawn; a short-lived link once `ready` (null with uploads off). */
  status: imageStatus,
  url: z.url().nullable(),
  /** What a drawn one was drawn from (or, for an edit, the change asked for). */
  prompt: z.string().nullable(),
  credit: stockCreditSchema.nullable(),
  /** Why it failed (an error code). */
  error: z.string().nullable(),
  createdAt: z.date(),
});
export type AssetImage = z.infer<typeof assetImageSchema>;

const assetSlotSchema = z.object({
  assetId: assetIdSchema,
  /** The Create tab's prompt, filled in from the original's reference (in English). */
  prompt: z.string(),
  /**
   * The slot's default, drawn after indexing: `id` names it for an edit (null for a
   * seeded template's, which can't be edited); null when the slot has none.
   */
  defaultImage: z
    .object({ id: imageIdSchema.nullable(), status: imageStatus, url: z.url().nullable() })
    .nullable(),
  /** The member's own images, oldest first. */
  images: z.array(assetImageSchema),
  /** The image the member's video uses; null is the default. */
  chosenId: imageIdSchema.nullable(),
  /** The slot's earlier choices, newest first: what undo goes back to (null: the default). */
  history: z.array(imageIdSchema.nullable()),
});
export type AssetSlot = z.infer<typeof assetSlotSchema>;

const directorAssetsSchema = z.object({
  slots: z.array(assetSlotSchema),
  /** The member's drawn images: for this video and its limit, and in the last day and its. */
  images: z.object({
    used: z.number().int().nonnegative(),
    perVideo: z.number().int().nonnegative(),
    today: z.number().int().nonnegative(),
    perDay: z.number().int().nonnegative(),
  }),
});
export type DirectorAssets = z.infer<typeof directorAssetsSchema>;

const stockPhotoSchema = z.object({
  provider: z.enum(stockProviders),
  /** The provider's own id for it. */
  id: z.string().min(1).max(40),
  /** A small version to show in the picker (the provider's own link). */
  previewUrl: z.url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The provider's description of it, for its alt text (may be empty). */
  alt: z.string(),
  author: z.string(),
  authorUrl: z.url(),
  pageUrl: z.url(),
});
export type StockPhoto = z.infer<typeof stockPhotoSchema>;

const slot = { videoId: videoIdSchema, assetId: assetIdSchema };

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Assets"], summary });

export const assetsContract = {
  /** Every asset slot of a ready plan, with the caller's own images and choices. */
  list: route("GET", "/director/{videoId}/assets", "Your images for a short's asset slots")
    .input(z.object({ videoId: videoIdSchema }))
    .output(directorAssetsSchema),
  /**
   * Draws an image for a still's slot from `prompt` (and the caller's ready
   * `director-asset-image` upload `referenceFileId`, as the photo to draw from); with
   * `baseId`, edits that image of the slot by `instruction` instead.
   */
  draw: route("POST", "/director/{videoId}/assets/{assetId}/drawings", "Create an image")
    .meta({
      rateLimit: { name: "director-drawings", points: 40, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({
        ...slot,
        prompt: z.string().trim().min(1).max(ASSET_PROMPT_MAX_LENGTH),
        instruction: z.string().trim().min(1).max(ASSET_INSTRUCTION_MAX_LENGTH).optional(),
        baseId: imageIdSchema.optional(),
        referenceFileId: fileIdSchema.optional(),
        /** A gap's slot (`gap-<n>`, `shot-<n>`): a Veo clip instead of a still. */
        clip: z.boolean().optional(),
      }),
    )
    .output(assetImageSchema),
  /** Adds the caller's ready `director-asset-image` upload to the slot. */
  addUpload: route("POST", "/director/{videoId}/assets/{assetId}/uploads", "Use your upload")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ ...slot, fileId: fileIdSchema }))
    .output(assetImageSchema),
  /** Copies a stock photo (from `searchStock`) into the slot, with its credit. */
  addStock: route("POST", "/director/{videoId}/assets/{assetId}/stock", "Use a stock photo")
    .meta({
      rateLimit: { name: "director-stock-copies", points: 60, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({ ...slot, provider: z.enum(stockProviders), photoId: z.string().min(1).max(40) }),
    )
    .output(assetImageSchema),
  /** The image the caller's video uses in the slot (no `imageId`: back to its default). */
  choose: route("POST", "/director/{videoId}/assets/{assetId}/choice", "Use an image")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ ...slot, imageId: imageIdSchema.nullable() }))
    .output(z.object({ ok: z.literal(true) })),
  /**
   * Stock photos for words (Pexels and Pixabay, the providers' results cached a day),
   * in the frame's shape. FEATURE_DISABLED without a provider.
   */
  searchStock: route("GET", "/director/stock", "Search stock photos")
    .meta({
      rateLimit: { name: "director-stock", points: 60, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({
        query: z.string().trim().min(1).max(STOCK_QUERY_MAX_LENGTH),
        orientation: z.enum(["portrait", "landscape", "square"]),
      }),
    )
    .output(z.array(stockPhotoSchema)),
};
