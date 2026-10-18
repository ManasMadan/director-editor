import { describe, expect, it } from "vitest";
import { DIRECTOR_SEED_COUNT, directorSeeds, directorSeedsSchema } from "./director-seeds";
import committed from "./director-seeds.json" with { type: "json" };
import { required } from "./objects";

describe("Director's seeded templates", () => {
  it("are the 6 committed Shorts, each with a plan and its audio", () => {
    expect(directorSeeds).toHaveLength(DIRECTOR_SEED_COUNT);
    expect(new Set(directorSeeds.map((seed) => seed.videoId)).size).toBe(DIRECTOR_SEED_COUNT);
    for (const seed of directorSeeds) {
      expect(seed.plan.shots.length).toBeGreaterThan(0);
      expect(seed.audioKey).toBe(`seed-audio/${seed.videoId}.m4a`);
    }
  });

  it("lose nothing to parsing: every field the AI service wrote is one the contract knows", () => {
    // zod drops keys a schema doesn't name, so a field the Python ShotPlan gained and the
    // contract's shotPlanSchema didn't would vanish from every workspace's copy.
    expect(directorSeeds).toEqual(committed);
  });

  it("keep a seed's media keys, which a seed may or may not have yet", () => {
    const first = required(directorSeeds[0], "a committed seed");
    const { musicKey, shots, ...barePlan } = first.plan;
    const { storyboardKey, previewKey, ...bareShot } = required(shots[0], "a shot");
    const bare = { ...first, plan: { ...barePlan, shots: [bareShot] } };
    const media = {
      ...first,
      plan: {
        ...barePlan,
        musicKey: `seed-media/${first.videoId}/music.mp3`,
        shots: [
          {
            ...bareShot,
            storyboardKey: `seed-media/${first.videoId}/shot-0.png`,
            previewKey: `seed-media/${first.videoId}/shot-0.mp4`,
          },
        ],
      },
    };
    expect(directorSeedsSchema.parse([media, ...committed.slice(1)])[0]).toEqual(media);
    const [parsed] = directorSeedsSchema.parse([bare, ...committed.slice(1)]);
    expect(parsed?.plan).not.toHaveProperty("musicKey");
    expect(parsed?.plan.shots[0]).not.toHaveProperty("storyboardKey");
    expect(
      directorSeedsSchema.safeParse([
        { ...media, plan: { ...media.plan, musicKey: "" } },
        ...committed.slice(1),
      ]).success,
    ).toBe(false);
  });

  it("refuse a file that isn't exactly 6 well-formed templates", () => {
    const [first] = committed;
    expect(directorSeedsSchema.safeParse(committed.slice(1)).success).toBe(false);
    expect(
      directorSeedsSchema.safeParse([{ ...first, videoId: "not a video" }, ...committed.slice(1)])
        .success,
    ).toBe(false);
    expect(
      directorSeedsSchema.safeParse([{ ...first, extra: true }, ...committed.slice(1)]).success,
    ).toBe(false);
  });
});
