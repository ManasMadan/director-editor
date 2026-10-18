import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { OriginalPlayer } from "@/modules/marketing/components/original-player";
import { renderPage } from "../render";

describe("the landing's original Short", () => {
  it("is a still with a play button until pressed, then YouTube's own player", async () => {
    const page = await renderPage(
      <OriginalPlayer
        videoId="22k0fZarxh8"
        thumbnail="data:image/gif;base64,R0lGODlhAQABAAAAACw="
        playLabel="Play the original"
        playerTitle="The original on YouTube"
      />,
      { url: "/" },
    );
    expect(page.getByTitle("The original on YouTube").query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Play the original" }));
    const player = page.getByTitle("The original on YouTube");
    await expect.element(player).toBeVisible();
    const src = new URL(player.element().getAttribute("src") ?? "");
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe("/embed/22k0fZarxh8");
    expect(src.searchParams.get("autoplay")).toBe("1");
    await expect
      .element(page.getByRole("button", { name: "Play the original" }))
      .not.toBeInTheDocument();
    // The button is gone: focus moves to the player that took its place, not to <body>.
    await expect.element(player).toHaveFocus();
  });

  it("rings its rounded frame while the play button has keyboard focus", async () => {
    const page = await renderPage(
      <OriginalPlayer
        videoId="22k0fZarxh8"
        thumbnail="data:image/gif;base64,R0lGODlhAQABAAAAACw="
        playLabel="Play the original"
        playerTitle="The original on YouTube"
      />,
      { url: "/" },
    );
    const button = page.getByRole("button", { name: "Play the original" });
    await userEvent.keyboard("{Tab}");
    await expect.element(button).toHaveFocus();
    // On the frame itself: a ring on the button would be clipped by the frame's corners or
    // hidden under the still. The frame has no ring until the button is focused.
    const frame = button.element().parentElement;
    expect(frame).not.toBeNull();
    expect(getComputedStyle(frame ?? document.body).boxShadow).not.toBe("none");
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => getComputedStyle(frame ?? document.body).boxShadow).toBe("none");
  });
});
