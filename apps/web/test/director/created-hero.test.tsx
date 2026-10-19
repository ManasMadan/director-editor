/** A created template's storyboard: its cards, or what became of the ones not drawn. */
import type { ServedShotPlan } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { CreatedHero } from "@/modules/director/components/created-hero";
import { StoryboardStateNote } from "@/modules/director/components/shot-list";
import { renderPage } from "../render";
import { planShot, shotPlan } from "./support";

describe("a created template's storyboard", () => {
  it("says why a card isn't coming instead of shimmering as if it were", async () => {
    const plan: ServedShotPlan = {
      ...shotPlan(),
      shots: [
        planShot({ title: "Pour" }),
        { ...planShot({ title: "Steam" }), storyboardState: "noAllowance" },
        { ...planShot({ title: "Sip" }), storyboardState: "dailyLimit" },
      ],
    };
    const page = await renderPage(<CreatedHero plan={plan} videoId="BA1mDsjg5Iw" />);
    // Still drawing: said to screen readers under the shimmer.
    await expect.element(page.getByText("Director is still drawing this shot")).toBeInTheDocument();
    await expect
      .element(page.getByText("No drawing: today's Director allowance is used up"))
      .toBeVisible();
    await expect.element(page.getByText("No drawing: you've made today's images")).toBeVisible();
  });

  it("says so under a shot's sketch too", async () => {
    const page = await renderPage(<StoryboardStateNote state="failed" />);
    await expect.element(page.getByText("Director couldn't draw this shot")).toBeVisible();
  });
});
