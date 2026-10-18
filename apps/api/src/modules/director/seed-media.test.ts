import { type DirectorSeed, directorSeeds } from "@repo/contracts/director-seeds";
import { videoIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { describe, expect, it } from "vitest";
import { seedMediaFor } from "./seed-media";

const seed = required(directorSeeds[0], "a committed seed");
const shots = seed.plan.shots.length;
const bare: DirectorSeed = { ...seed, media: undefined };

describe("a seed's media", () => {
  it("is the committed seed's, looked up by the video id", () => {
    expect(seedMediaFor(seed.videoId, shots)).toEqual(seed.media);
  });

  it("is nobody's for a Short that isn't a seed", () => {
    expect(seedMediaFor(videoIdSchema.parse("dQw4w9WgXcQ"), shots)).toBeNull();
  });

  it("isn't an older copy's: one with another number of shots would show the wrong scenes", () => {
    expect(seedMediaFor(seed.videoId, shots - 1)).toBeNull();
    expect(seedMediaFor(seed.videoId, shots + 1)).toBeNull();
  });

  it("is nothing for a seed with no media yet", () => {
    expect(seedMediaFor(seed.videoId, shots, [bare])).toBeNull();
  });
});
