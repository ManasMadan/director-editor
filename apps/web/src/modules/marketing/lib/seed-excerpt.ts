/**
 * The 6 seed Shorts every workspace starts with, as the landing shows them, and the whole
 * plan of the one it x-rays. Real data, never written by hand: seed-excerpt.json is copied
 * from the AI service's seed templates (apps/ai/app/seeds/templates.json, built by
 * `bun run --filter @repo/ai seeds:build`, which indexes each Short with Gemini on Vertex
 * AI) and their channels (apps/ai/app/seeds/seeds.json). seed-excerpt.test.ts fails the
 * moment either drifts from it; copy it again from those files when it does.
 *
 * It's a copy only until the seed templates live in a package the web app can import;
 * then this file imports them from there instead.
 *
 * Read on the server only (the landing is a server component), so none of it reaches the
 * browser's JavaScript.
 */
import { shotPlanSchema } from "@repo/contracts/api";
import { videoIdSchema as videoId } from "@repo/contracts/ids";
import * as z from "zod";
import excerpt from "./seed-excerpt.json";

const shotSchema = shotPlanSchema.shape.shots.element;

const excerptSchema = z.object({
  templates: z
    .array(
      z.object({
        videoId,
        /** The YouTube channel that made the original. */
        channel: z.string(),
        /** The Gemini model that wrote the plan. */
        model: z.string(),
        title: z.string(),
        format: z.string(),
        durationSeconds: z.number(),
        /** How many shots the plan has. */
        shots: z.number().int().min(1),
      }),
    )
    .length(6),
  xray: z.object({
    videoId,
    channel: z.string(),
    model: z.string(),
    // A plan always has a first shot; the tuple lets the x-ray say so without a check.
    plan: shotPlanSchema.extend({ shots: z.tuple([shotSchema], shotSchema) }),
  }),
});

const parsed = excerptSchema.parse(excerpt);

export const SEED_TEMPLATES = parsed.templates;
export const XRAY = parsed.xray;
