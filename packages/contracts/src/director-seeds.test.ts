import { describe, expect, it } from "vitest";
import * as z from "zod";
import mediaKeyRules from "./director-seed-media.json" with { type: "json" };
import { DIRECTOR_SEED_COUNT, directorSeeds, directorSeedsSchema } from "./director-seeds";
import committed from "./director-seeds.json" with { type: "json" };
import { required } from "./objects";

const first = required(directorSeeds[0], "a committed seed");
const media = required(first.media, "the first seed's media");
const base = `seed-media/${first.videoId}`;

/** The committed file with the first seed's media swapped for `swapped`. */
function withMedia(swapped: unknown) {
  return [{ ...first, media: swapped }, ...committed.slice(1)];
}

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

  it("each carry their media: a storyboard and a preview per shot, and a track", () => {
    for (const seed of directorSeeds) {
      const at = `seed-media/${seed.videoId}`;
      expect(seed.media?.music).toBe(`${at}/music.mp3`);
      expect(seed.media?.shots).toEqual(
        seed.plan.shots.map((_, index) => ({
          storyboard: `${at}/shot-${index}.png`,
          preview: `${at}/shot-${index}.mp4`,
        })),
      );
      // The plan itself names no storage path: it's what the planner writes, and what
      // every workspace's copy of it holds.
      expect(JSON.stringify(seed.plan)).not.toContain("seed-media/");
    }
  });

  it("may have no media yet, or only some of it", () => {
    expect(directorSeedsSchema.safeParse(withMedia(undefined)).success).toBe(true);
    const some = {
      shots: media.shots.map((_, index) => (index === 0 ? { preview: `${base}/shot-0.mp4` } : {})),
    };
    expect(directorSeedsSchema.safeParse(withMedia(some)).success).toBe(true);
  });

  it("refuse a media key anywhere but its own seed, shot and kind", () => {
    const shots = media.shots;
    const swapShot = (index: number, shot: unknown) =>
      withMedia({ ...media, shots: shots.map((each, at) => (at === index ? shot : each)) });
    const refused = [
      // Another object altogether: a member's take in another workspace.
      withMedia({ ...media, music: "files/0199f3a0-0000-7000-8000-000000000001/take.webm" }),
      // Another seed's media.
      withMedia({ ...media, music: "seed-media/152Jy2c3XSM/music.mp3" }),
      // The wrong kind of file for what it is.
      withMedia({ ...media, music: `${base}/shot-0.mp4` }),
      swapShot(0, { storyboard: `${base}/shot-0.mp4` }),
      swapShot(0, { preview: `${base}/shot-0.png` }),
      // Another shot's.
      swapShot(1, { storyboard: `${base}/shot-0.png` }),
      // A path that climbs out of the seed's folder.
      swapShot(0, { storyboard: `${base}/../x/shot-0.png` }),
      // Not one entry per shot.
      withMedia({ ...media, shots: shots.slice(1) }),
      withMedia({ ...media, extra: true }),
    ];
    for (const file of refused) {
      expect(directorSeedsSchema.safeParse(file).success).toBe(false);
    }
  });

  it("take a default image only for an asset the plan has, at its own key", () => {
    const chart = {
      id: "chart",
      kind: "image",
      title: "The chart",
      role: "Under the speaker",
      description: "A chart.",
      prompt: "A chart.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 1,
      defaultSource: "create",
      personalisable: false,
      ask: null,
      secondScreen: false,
      reference: {
        subject: "A chart",
        composition: "Centred",
        style: "Flat",
        palette: "Black and white",
        blackAndWhite: true,
        aspectRatio: "1:1",
        text: [],
        mood: "Calm",
      },
    };
    const withAssets = (assets: Record<string, string>) => [
      { ...first, plan: { ...first.plan, assets: [chart] }, media: { ...media, assets } },
      ...committed.slice(1),
    ];
    expect(
      directorSeedsSchema.safeParse(withAssets({ chart: `${base}/asset-chart.png` })).success,
    ).toBe(true);
    expect(
      directorSeedsSchema.safeParse(withAssets({ chart: `${base}/asset-chart.jpg` })).success,
    ).toBe(true);
    const refusals: Record<string, string>[] = [
      { chart: `${base}/asset-logo.png` },
      // An asset the plan doesn't have.
      { logo: `${base}/asset-logo.png` },
    ];
    for (const refused of refusals) {
      expect(directorSeedsSchema.safeParse(withAssets(refused)).success).toBe(false);
    }
  });

  it("check every media key against the rule the AI service's scripts check it with", () => {
    // director-seed-media.json is read by apps/ai/scripts/build_seeds.py too, so the
    // file's writers and its reader agree on what a key may be.
    const schema = JSON.stringify(z.toJSONSchema(directorSeedsSchema, { io: "input" }));
    // (as a RegExp's source, which escapes the slashes)
    expect(schema).toContain(JSON.stringify(new RegExp(mediaKeyRules.keyPattern).source));
    expect(schema).toContain(`"maxLength":${mediaKeyRules.keyMaxLength}`);
  });

  it("refuse a file that isn't exactly 6 well-formed templates", () => {
    const [entry] = committed;
    expect(directorSeedsSchema.safeParse(committed.slice(1)).success).toBe(false);
    expect(
      directorSeedsSchema.safeParse([{ ...entry, videoId: "not a video" }, ...committed.slice(1)])
        .success,
    ).toBe(false);
    expect(
      directorSeedsSchema.safeParse([{ ...entry, extra: true }, ...committed.slice(1)]).success,
    ).toBe(false);
  });
});
