import type { Asset } from "@repo/contracts/api";
import { type DirectorSeed, directorSeeds } from "@repo/contracts/director-seeds";
import { videoIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { describe, expect, it } from "vitest";
import { planAssetImages, withAssetImages } from "./asset-images";
import { seedAssetImages, withSeedAssets } from "./seed-media";

const PLAN_ID = "0199f3a0-0000-7000-8000-000000000001";
const at = `director-assets/${PLAN_ID}`;

const asset = (id: string): Asset => ({
  id,
  kind: "image",
  title: "The chart",
  role: "Under the speaker",
  description: "A chart of twelve archetypes.",
  prompt: 'A flat chart titled "12 ARCHETYPES".',
  sourceStartSeconds: 0,
  sourceEndSeconds: 8,
  defaultSource: "create",
  personalisable: true,
  ask: null,
  secondScreen: false,
  reference: {
    subject: "Twelve archetypes",
    composition: "Title on top, rows below",
    style: "Flat infographic",
    palette: "Black and white",
    blackAndWhite: true,
    aspectRatio: "9:8",
    text: ["12 ARCHETYPES"],
    brands: [],
    mood: "Bold",
  },
});

describe("a member's plan's asset images", () => {
  it("say how each is coming along, with the key to sign once one's ready", () => {
    expect(
      planAssetImages(PLAN_ID, [
        { assetId: "chart", status: "ready", objectKey: `${at}/chart.png` },
        { assetId: "card", status: "ready", objectKey: `${at}/card.jpg` },
        { assetId: "logo", status: "pending", objectKey: null },
        { assetId: "end", status: "generating", objectKey: null },
        { assetId: "photo", status: "failed", objectKey: null },
      ]),
    ).toEqual([
      { assetId: "chart", status: "ready", key: `${at}/chart.png` },
      { assetId: "card", status: "ready", key: `${at}/card.jpg` },
      { assetId: "logo", status: "making", key: null },
      { assetId: "end", status: "making", key: null },
      { assetId: "photo", status: "failed", key: null },
    ]);
  });

  it("never sign a key outside the plan's own folder and the asset's own name", () => {
    const elsewhere = [
      `files/${PLAN_ID}/take.webm`,
      `director-assets/0199f3a0-0000-7000-8000-000000000002/chart.png`,
      `${at}/card.png`,
      `${at}/chart.webm`,
      `${at}/../chart.png`,
      null,
    ];
    for (const objectKey of elsewhere) {
      expect(planAssetImages(PLAN_ID, [{ assetId: "chart", status: "ready", objectKey }])).toEqual([
        { assetId: "chart", status: "failed", key: null },
      ]);
    }
  });

  it("are put on their assets, leaving an asset with none as it is", () => {
    const [chart, music] = withAssetImages(
      [asset("chart"), asset("music")],
      [{ image: { assetId: "chart", status: "ready", key: "k" }, url: "https://files.test/k" }],
    );
    expect(chart).toEqual({
      ...asset("chart"),
      image: { status: "ready", url: "https://files.test/k" },
    });
    expect(music).toEqual(asset("music"));
  });
});

describe("a seeded template's assets", () => {
  const seed = required(directorSeeds[0], "a committed seed");
  const withAssets: DirectorSeed = {
    ...seed,
    plan: { ...seed.plan, assets: [asset("chart")], edits: [] },
    media: { shots: [], assets: { chart: `seed-media/${seed.videoId}/asset-chart.png` } },
  };

  it("are the committed seed's, filled in after the copy was made", () => {
    const copy = { ...seed.plan, assets: [], edits: [] };
    expect(withSeedAssets(seed.videoId, copy, [withAssets]).assets).toEqual([asset("chart")]);
    expect(seedAssetImages(seed.videoId, copy, [withAssets])).toEqual([
      { assetId: "chart", status: "ready", key: `seed-media/${seed.videoId}/asset-chart.png` },
    ]);
  });

  it("are the copy's own for an older copy, or a Short that isn't a seed", () => {
    const older = { ...seed.plan, shots: seed.plan.shots.slice(1) };
    expect(withSeedAssets(seed.videoId, older, [withAssets])).toBe(older);
    expect(seedAssetImages(seed.videoId, older, [withAssets])).toEqual([]);
    const other = videoIdSchema.parse("dQw4w9WgXcQ");
    expect(withSeedAssets(other, seed.plan, [withAssets])).toBe(seed.plan);
    expect(seedAssetImages(seed.videoId, seed.plan, [{ ...seed, media: undefined }])).toEqual([]);
  });
});
