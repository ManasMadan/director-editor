import { describe, expect, it } from "vitest";
import { DIRECTOR_SEED_COUNT, directorSeeds, directorSeedsSchema } from "./director-seeds";
import committed from "./director-seeds.json" with { type: "json" };

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
