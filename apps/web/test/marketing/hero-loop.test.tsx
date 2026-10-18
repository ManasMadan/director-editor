import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "@/modules/marketing/landing.css";
import { HeroLoop } from "@/modules/marketing/components/hero-loop";
import { renderPage } from "../render";

describe("the landing's looping conversation", () => {
  it("pauses where it is, and plays again, from its button", async () => {
    const page = await renderPage(
      <HeroLoop pauseLabel="Pause the conversation">
        <p className="hero-say-1">Let's start at the market.</p>
      </HeroLoop>,
      { url: "/" },
    );
    const line = page.getByText("Let's start at the market.");
    const pause = page.getByRole("button", { name: "Pause the conversation" });
    await expect.element(pause).toHaveAttribute("aria-pressed", "false");
    expect(getComputedStyle(line.element()).animationPlayState).toBe("running");

    await userEvent.click(pause);
    await expect.element(pause).toHaveAttribute("aria-pressed", "true");
    expect(getComputedStyle(line.element()).animationPlayState).toBe("paused");

    await userEvent.click(pause);
    await expect.element(pause).toHaveAttribute("aria-pressed", "false");
    expect(getComputedStyle(line.element()).animationPlayState).toBe("running");
  });
});
