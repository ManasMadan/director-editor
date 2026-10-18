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
import mediaKeyRules from "./director-seed-media.json" with { type: "json" };
import committed from "./director-seeds.json" with { type: "json" };
import { videoIdSchema } from "./ids";

export const DIRECTOR_SEED_COUNT = 6;

/**
 * A seed's generated media (apps/ai/scripts/seed_media.py) is stored under
 * `seed-media/<videoId>/`, and the API signs a link to whatever key the committed file
 * names. So each key is held to exactly the object it must be: this rule (shared with
 * the AI service's scripts through director-seed-media.json), then, for the seed, its own
 * folder, its shot's position and the right kind of file.
 */
const storedKey = z
  .string()
  .max(mediaKeyRules.keyMaxLength)
  .regex(new RegExp(mediaKeyRules.keyPattern));
const mediaKey = storedKey.optional();

const seedMediaSchema = z.strictObject({
  /** The music track. */
  music: mediaKey,
  /** One entry per shot of the plan, in its order. */
  shots: z.array(z.strictObject({ storyboard: mediaKey, preview: mediaKey })),
  /** The default image of each asset of the plan that has one, by the asset's id. */
  assets: z.record(z.string(), storedKey).optional(),
});
type SeedMedia = z.infer<typeof seedMediaSchema>;

/** Every key `media` names, each with the only keys it may be for this seed. */
function expectedKeys(videoId: string, assetIds: readonly string[], media: SeedMedia) {
  const at = `seed-media/${videoId}`;
  return [
    { key: media.music, allowed: [`${at}/music.mp3`, `${at}/music.wav`] },
    ...media.shots.flatMap((shot, index) => [
      { key: shot.storyboard, allowed: [`${at}/shot-${index}.png`, `${at}/shot-${index}.jpg`] },
      { key: shot.preview, allowed: [`${at}/shot-${index}.mp4`] },
    ]),
    // An asset the plan hasn't may have no key at all.
    ...Object.entries(media.assets ?? {}).map(([id, key]) => ({
      key,
      allowed: assetIds.includes(id) ? [`${at}/asset-${id}.png`, `${at}/asset-${id}.jpg`] : [],
    })),
  ];
}

const directorSeedSchema = z
  .strictObject({
    videoId: videoIdSchema,
    plan: shotPlanSchema,
    /** The model that wrote the plan. */
    model: z.string().min(1),
    /** The Short's original audio: its object key in storage (uploaded once, by hand). */
    audioKey: z.string().min(1),
    /** Its storyboard cards, preview clips and music, once made; see `mediaKey`. */
    media: seedMediaSchema.optional(),
  })
  .superRefine(({ videoId, plan, media }, context) => {
    if (!media) {
      return;
    }
    if (media.shots.length !== plan.shots.length) {
      context.addIssue({ code: "custom", path: ["media", "shots"], message: "one per shot" });
    }
    const assetIds = plan.assets.map((asset) => asset.id);
    for (const { key, allowed } of expectedKeys(videoId, assetIds, media)) {
      if (key !== undefined && !allowed.includes(key)) {
        context.addIssue({ code: "custom", path: ["media"], message: `${key} isn't this seed's` });
      }
    }
  });
export type DirectorSeed = z.infer<typeof directorSeedSchema>;

export const directorSeedsSchema = z.array(directorSeedSchema).length(DIRECTOR_SEED_COUNT);

/** In the order the seed list gives them (apps/ai/app/seeds/seeds.json). */
export const directorSeeds: readonly DirectorSeed[] = directorSeedsSchema.parse(committed);
