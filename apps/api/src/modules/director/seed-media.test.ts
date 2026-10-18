import { type DirectorSeed, directorSeeds } from "@repo/contracts/director-seeds";
import { videoIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { describe, expect, it } from "vitest";
import { seedMediaKeys, withMediaLinks } from "./seed-media";

const seed = required(directorSeeds[0], "a committed seed");
const media = required(seed.media, "the seed's media");
const shots = seed.plan.shots.length;
const at = `seed-media/${seed.videoId}`;

describe("a seed's media keys", () => {
  it("are the committed seed's, looked up by the video id", () => {
    const keys = seedMediaKeys(seed.videoId, shots);
    expect(keys).toHaveLength(1 + 2 * shots);
    expect(keys).toContainEqual({ kind: "music", shot: null, key: media.music });
    expect(keys).toContainEqual({ kind: "storyboard", shot: 1, key: `${at}/shot-1.png` });
    expect(keys).toContainEqual({ kind: "preview", shot: 1, key: `${at}/shot-1.mp4` });
  });

  it("are none for a Short that isn't a seed", () => {
    expect(seedMediaKeys(videoIdSchema.parse("dQw4w9WgXcQ"), shots)).toEqual([]);
  });

  it("are none for an older copy: another number of shots would show the wrong scenes", () => {
    expect(seedMediaKeys(seed.videoId, shots - 1)).toEqual([]);
    expect(seedMediaKeys(seed.videoId, shots + 1)).toEqual([]);
  });

  it("are only those the seed has made so far", () => {
    const none: DirectorSeed = { ...seed, media: undefined };
    expect(seedMediaKeys(seed.videoId, shots, [none])).toEqual([]);
    const some: DirectorSeed = {
      ...seed,
      media: {
        shots: media.shots.map((_, index) => (index === 2 ? { preview: `${at}/shot-2.mp4` } : {})),
      },
    };
    expect(seedMediaKeys(seed.videoId, shots, [some])).toEqual([
      { kind: "preview", shot: 2, key: `${at}/shot-2.mp4` },
    ]);
  });
});

describe("a plan with its media linked", () => {
  const keys = seedMediaKeys(seed.videoId, shots);

  it("carries each signed link where its medium belongs", () => {
    const served = withMediaLinks(
      seed.plan,
      keys.map((key) => ({ media: key, url: `https://files.test/${key.key}?sig=1` })),
    );
    expect(served.musicUrl).toBe(`https://files.test/${media.music}?sig=1`);
    expect(served.shots[3]).toMatchObject({
      ...seed.plan.shots[3],
      storyboardUrl: `https://files.test/${at}/shot-3.png?sig=1`,
      previewUrl: `https://files.test/${at}/shot-3.mp4?sig=1`,
    });
  });

  it("leaves out a link that didn't come back, or a medium not made", () => {
    const served = withMediaLinks(seed.plan, [
      { media: { kind: "preview", shot: 0, key: `${at}/shot-0.mp4` }, url: "https://files.test/p" },
      { media: { kind: "music", shot: null, key: `${at}/music.mp3` }, url: null },
    ]);
    expect(served).not.toHaveProperty("musicUrl");
    expect(served.shots[0]).toEqual({ ...seed.plan.shots[0], previewUrl: "https://files.test/p" });
    expect(served.shots[1]).toEqual(seed.plan.shots[1]);
  });
});
