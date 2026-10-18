import { describe, expect, it } from "vitest";
import { directorSeeds } from "../director-seeds";
import { required } from "../objects";
import { directorPlanSchema, shotPlanSchema } from "./director";

const seed = required(directorSeeds[0], "a committed seed");
const [shot] = seed.plan.shots;
const now = new Date();
const served = {
  id: "0199f3a0-0000-7000-8000-000000000001",
  videoId: seed.videoId,
  source: "seed",
  status: "ready",
  stage: "ready",
  error: null,
  model: seed.model,
  audio: { status: "none", url: null },
  createdAt: now,
  updatedAt: now,
};

describe("a plan as the API serves it", () => {
  it("links a seed's media rather than naming where it's stored", () => {
    const plan = directorPlanSchema.parse({
      ...served,
      plan: {
        ...seed.plan,
        musicUrl: "https://files.example.com/music.mp3?sig=1",
        musicKey: "seed-media/x/music.mp3",
        shots: [
          {
            ...shot,
            storyboardUrl: "https://files.example.com/shot-0.png?sig=1",
            previewUrl: "https://files.example.com/shot-0.mp4?sig=1",
            storyboardKey: "seed-media/x/shot-0.png",
            previewKey: "seed-media/x/shot-0.mp4",
          },
        ],
      },
    });

    expect(plan.plan?.musicUrl).toBe("https://files.example.com/music.mp3?sig=1");
    expect(plan.plan?.shots[0]).toMatchObject({
      storyboardUrl: "https://files.example.com/shot-0.png?sig=1",
      previewUrl: "https://files.example.com/shot-0.mp4?sig=1",
    });
    // The keys are the API's to sign, not the caller's to see.
    expect(plan.plan).not.toHaveProperty("musicKey");
    expect(plan.plan?.shots[0]).not.toHaveProperty("storyboardKey");
    expect(plan.plan?.shots[0]).not.toHaveProperty("previewKey");
  });

  it("names no storage path in a plan: a seed's media lives beside it, in the seed", () => {
    const stored = shotPlanSchema.parse({
      ...seed.plan,
      musicKey: "files/someone/take.webm",
      shots: [{ ...shot, storyboardKey: "files/someone/take.webm" }],
    });

    expect(JSON.stringify(stored)).not.toContain("files/");
  });

  it("serves a plan with no media as it always has", () => {
    const plan = directorPlanSchema.parse({ ...served, plan: seed.plan });

    expect(plan.plan).not.toHaveProperty("musicUrl");
    expect(plan.plan?.shots[0]).not.toHaveProperty("storyboardUrl");
  });

  it("refuses a media link that isn't a URL", () => {
    expect(
      directorPlanSchema.safeParse({ ...served, plan: { ...seed.plan, musicUrl: "music.mp3" } })
        .success,
    ).toBe(false);
  });
});
