/**
 * Director's seeded templates: the 6 YouTube Shorts every workspace's library starts
 * with, each indexed for real with Gemini. The AI service writes director-seeds.json
 * (apps/ai/scripts/build_seeds.py: `bun run --filter @repo/ai seeds:build`, then commit
 * the file) and the API copies it into every new workspace
 * (apps/api/src/modules/director/seeds.repository.ts), bundled into its build.
 *
 * The file lives here rather than in either service because both use it, and services
 * never import each other. It's parsed when this module loads, so a file that drifted from
 * the plan's contract stops the API at start-up instead of reaching anyone's library.
 */
import * as z from "zod";
import { shotPlanSchema } from "./api/director";
import committed from "./director-seeds.json" with { type: "json" };
import { videoIdSchema } from "./ids";

export const DIRECTOR_SEED_COUNT = 6;

const directorSeedSchema = z.strictObject({
  videoId: videoIdSchema,
  plan: shotPlanSchema,
  /** The model that wrote the plan. */
  model: z.string().min(1),
  /** The Short's original audio: its object key in storage (uploaded once, by hand). */
  audioKey: z.string().min(1),
});
export type DirectorSeed = z.infer<typeof directorSeedSchema>;

export const directorSeedsSchema = z.array(directorSeedSchema).length(DIRECTOR_SEED_COUNT);

/** In the order the seed list gives them (apps/ai/app/seeds/seeds.json). */
export const directorSeeds: readonly DirectorSeed[] = directorSeedsSchema.parse(committed);
