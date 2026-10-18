import { readFileSync } from "node:fs";
import { shotPlanSchema } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { SEED_TEMPLATES, XRAY } from "./seed-excerpt";

// The seed data the AI service ships (apps/ai/app/seeds): the landing copies part of it,
// and must never drift from it or show anything Gemini didn't write.
const read = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../../ai/app/seeds/${file}`, import.meta.url), "utf8"));
const templates = z
  .array(z.object({ videoId: z.string(), model: z.string(), plan: shotPlanSchema }))
  .parse(read("templates.json"));
const shorts = z
  .array(z.object({ videoId: z.string(), channel: z.string() }))
  .parse(read("seeds.json"));

describe("the landing's seed excerpt", () => {
  it("is the AI service's 6 seed templates, as Gemini wrote them", () => {
    expect(SEED_TEMPLATES).toEqual(
      templates.map(({ videoId, model, plan }) => ({
        videoId,
        channel: shorts.find((short) => short.videoId === videoId)?.channel,
        model,
        title: plan.title,
        format: plan.format,
        durationSeconds: plan.durationSeconds,
        shots: plan.shots.length,
      })),
    );
  });

  it("x-rays one seed with its whole plan, unchanged", () => {
    const { videoId, channel, model, plan } = XRAY;
    expect(templates).toContainEqual({ videoId, model, plan });
    expect(shorts).toContainEqual({ videoId, channel });
  });
});
