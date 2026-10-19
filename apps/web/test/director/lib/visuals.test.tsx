/**
 * The pictures the finished video places: which link each slot is read from, read as
 * images or clips ready to draw (one that can't be read left out), and let go after.
 */
import type { AssetImage, AssetSlot, ServedShotPlan } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { base64Of } from "@/modules/director/lib/media";
import { loadVisuals, releaseVisuals, slotMedia } from "@/modules/director/lib/visuals";
import { recordVideo, shotPlan } from "../support";

// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const image = (overrides: Partial<AssetImage>): AssetImage => ({
  id: crypto.randomUUID(),
  origin: "created",
  media: "image",
  status: "ready",
  url: "https://cdn.test/mine.png",
  prompt: null,
  credit: null,
  error: null,
  createdAt: new Date(),
  ...overrides,
});

const slot = (assetId: string, overrides: Partial<AssetSlot> = {}): AssetSlot => ({
  assetId,
  prompt: "p",
  defaultImage: null,
  images: [],
  chosenId: null,
  history: [],
  ...overrides,
});

describe("each slot's picture", () => {
  it("is the member's choice, else the slot's default, else the plan's own", () => {
    const clip = image({ media: "video", url: "https://cdn.test/clip.webm" });
    const drawing = image({ status: "making", url: null });
    const plan: ServedShotPlan = {
      ...shotPlan(),
      assets: ["chart", "card", "logo", "badge"].map((id) => ({
        id,
        kind: "image" as const,
        title: id,
        role: "r",
        description: "d",
        prompt: "p",
        sourceStartSeconds: 0,
        sourceEndSeconds: 1,
        defaultSource: "create" as const,
        personalisable: false,
        ask: null,
        secondScreen: false,
        reference: {
          subject: "s",
          composition: "c",
          style: "s",
          palette: "p",
          blackAndWhite: false,
          aspectRatio: "9:16" as const,
          text: [],
          brands: [],
          mood: "m",
        },
        image:
          id === "badge"
            ? { status: "making" as const, url: null }
            : { status: "ready" as const, url: `https://cdn.test/plan-${id}.png` },
      })),
    };
    const media = slotMedia(plan, [
      slot("chart", { images: [clip], chosenId: clip.id }),
      // Chosen, but still being drawn: the slot's default meanwhile.
      slot("card", {
        images: [drawing],
        chosenId: drawing.id,
        defaultImage: { id: null, status: "ready", url: "https://cdn.test/default-card.png" },
      }),
      slot("logo", { defaultImage: { id: null, status: "making", url: null } }),
    ]);
    expect(Object.fromEntries(media)).toEqual({
      chart: { url: "https://cdn.test/clip.webm", video: true },
      card: { url: "https://cdn.test/default-card.png", video: false },
      logo: { url: "https://cdn.test/plan-logo.png", video: false },
    });
  });
});

describe("reading the pictures", () => {
  it("reads images and clips ready to draw, leaves out what can't be read, and lets them go", async () => {
    const footage = await recordVideo(1);
    await commands.serveRequests("^https://cdn\\.test/ok\\.png$", {
      contentType: "image/png",
      base64: PNG,
    });
    await commands.serveRequests("^https://cdn\\.test/clip\\.webm$", {
      contentType: "video/webm",
      base64: await base64Of(footage),
    });
    // Not an image, though it says it is; and not a video.
    await commands.serveRequests("^https://cdn\\.test/broken\\.", {
      contentType: "image/png",
      base64: btoa("not a picture"),
    });
    await commands.failRequests("cdn.test/expired.png", { status: 403 });
    const visuals = await loadVisuals(
      new Map([
        ["chart", { url: "https://cdn.test/ok.png", video: false }],
        ["gap-1", { url: "https://cdn.test/clip.webm", video: true }],
        ["card", { url: "https://cdn.test/broken.png", video: false }],
        ["gap-2", { url: "https://cdn.test/broken.webm", video: true }],
        ["logo", { url: "https://cdn.test/expired.png", video: false }],
      ]),
    );
    expect([...visuals.keys()]).toEqual(["chart", "gap-1"]);
    const clip = visuals.get("gap-1");
    expect(clip?.kind === "video" && clip.video.loop).toBe(true);

    releaseVisuals(visuals);
    const picture = visuals.get("chart");
    // A closed bitmap has no size left.
    expect(picture?.kind === "image" && picture.image.width).toBe(0);
    expect(clip?.kind === "video" && clip.video.paused).toBe(true);
  });
});
