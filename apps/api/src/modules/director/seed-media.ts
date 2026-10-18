/**
 * A seeded template's generated media (storyboard cards, preview clips, music), from the
 * committed seed file bundled into this build, never from a workspace's stored plan:
 * every key there was checked against its seed, shot and kind when the file loaded
 * (@repo/contracts/director-seeds), and a workspace seeded before the media existed gets
 * it all the same, with no copy to update.
 */
import { type DirectorSeed, directorSeeds, type SeedMedia } from "@repo/contracts/director-seeds";
import type { VideoId } from "@repo/contracts/ids";

/**
 * The media of the committed seed of `videoId`, for a stored plan of `shotCount` shots;
 * null for a Short that isn't a seed, a seed with no media yet, or a copy with another
 * number of shots than the seed has now (an older plan, whose scenes the media wouldn't
 * show).
 */
export function seedMediaFor(
  videoId: VideoId,
  shotCount: number,
  seeds: readonly DirectorSeed[] = directorSeeds,
): SeedMedia | null {
  const seed = seeds.find((each) => each.videoId === videoId);
  if (!seed?.media || seed.plan.shots.length !== shotCount) {
    return null;
  }
  return seed.media;
}
