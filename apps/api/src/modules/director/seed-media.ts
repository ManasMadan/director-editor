/**
 * A seeded template's generated media (storyboard cards, preview clips, music), from the
 * committed seed file bundled into this build, never from a workspace's stored plan:
 * every key there was checked against its seed, shot and kind when the file loaded
 * (@repo/contracts/director-seeds), and a workspace seeded before the media existed gets
 * it all the same, with no copy to update.
 */
import type { ServedShotPlan, ShotPlan } from "@repo/contracts/api";
import { type DirectorSeed, directorSeeds } from "@repo/contracts/director-seeds";
import type { VideoId } from "@repo/contracts/ids";

/** One medium of a seed: its key in storage, and the shot it's of (null: the music). */
export interface SeedMediaKey {
  kind: "storyboard" | "preview" | "music";
  shot: number | null;
  key: string;
}

/**
 * Every media key the committed seed of `videoId` has, for a stored plan of `shotCount`
 * shots; none for a Short that isn't a seed, a seed with no media yet, or a copy with
 * another number of shots than the seed has now (an older plan, whose scenes the media
 * wouldn't show).
 */
export function seedMediaKeys(
  videoId: VideoId,
  shotCount: number,
  seeds: readonly DirectorSeed[] = directorSeeds,
): SeedMediaKey[] {
  const seed = seeds.find((each) => each.videoId === videoId);
  if (!seed?.media || seed.plan.shots.length !== shotCount) {
    return [];
  }
  const { music, shots } = seed.media;
  const keys: { kind: SeedMediaKey["kind"]; shot: number | null; key: string | undefined }[] = [
    { kind: "music", shot: null, key: music },
    ...shots.flatMap((shot, index) => [
      { kind: "storyboard" as const, shot: index, key: shot.storyboard },
      { kind: "preview" as const, shot: index, key: shot.preview },
    ]),
  ];
  return keys.flatMap(({ key, ...at }) => (key ? [{ ...at, key }] : []));
}

/**
 * `plan` with each signed link in place: `musicUrl` on the plan, `storyboardUrl` and
 * `previewUrl` on its shots. A link that came back null (uploads off) is left out, as the
 * audio's is.
 */
export function withMediaLinks(
  plan: ShotPlan,
  signed: readonly { media: SeedMediaKey; url: string | null }[],
): ServedShotPlan {
  const urlOf = (kind: SeedMediaKey["kind"], shot: number | null) =>
    signed.find(({ media }) => media.kind === kind && media.shot === shot)?.url;
  const musicUrl = urlOf("music", null);
  return {
    ...plan,
    ...(musicUrl && { musicUrl }),
    shots: plan.shots.map((shot, index) => {
      const storyboardUrl = urlOf("storyboard", index);
      const previewUrl = urlOf("preview", index);
      return {
        ...shot,
        ...(storyboardUrl && { storyboardUrl }),
        ...(previewUrl && { previewUrl }),
      };
    }),
  };
}
