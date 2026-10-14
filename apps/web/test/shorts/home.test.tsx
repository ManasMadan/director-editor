import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { HomePage } from "@/modules/shorts";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { editShorts, type Feed } from "./support";

const FIRST = /^GRWM: fall layers, piece by piece/;

describe("the Shorts home", () => {
  it("shows the most watched shorts, each opening in the player", async () => {
    await signUp();
    const page = await renderPage(<HomePage />, { url: "/home" });
    const card = page.getByRole("link", { name: FIRST });
    await expect.element(card).toHaveAttribute("href", "/shorts/jNQXAC9IVRw");
    await expect.element(card).toMatchTextContent(/1\.8M views$/);
    await expect
      .element(page.getByRole("link", { name: "Director" }))
      .toHaveAttribute("href", "/home");
    await expect
      .element(page.getByRole("link", { name: "Your account" }))
      .toHaveAttribute("href", "/settings");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect
      .element(nav.getByRole("link", { name: "Home" }))
      .toHaveAttribute("aria-current", "page");
    await expect
      .element(nav.getByRole("link", { name: "Shorts" }))
      .not.toHaveAttribute("aria-current");
    await expect.element(nav.getByRole("link", { name: "You" })).toHaveAttribute("href", "/saved");
    // Everything has loaded: the feed is all there is, no next page.
    expect(page.getByRole("button", { name: "Show more" }).query()).toBeNull();
    await userEvent.click(card);
    await expect.poll(currentUrl).toBe("/shorts/jNQXAC9IVRw");
  });

  it("shows a topic's shorts when its chip is picked", async () => {
    await signUp();
    const page = await renderPage(<HomePage />, { url: "/home" });
    await expect.element(page.getByRole("link", { name: /Dropped my pen/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "All" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(page.getByRole("button", { name: "GRWM" }));
    await expect
      .element(page.getByRole("button", { name: "GRWM" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: "All" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect
      .element(page.getByRole("link", { name: /Get ready with me: date night/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /Dropped my pen/ }))
      .not.toBeInTheDocument();
  });

  it("shows more of the feed a page at a time", async () => {
    await signUp();
    editShorts<Feed>("feed", (feed, input) =>
      input.pageToken === "page-2"
        ? { items: feed.items.slice(2, 3), nextPageToken: null }
        : { items: feed.items.slice(0, 2), nextPageToken: "page-2" },
    );
    const page = await renderPage(<HomePage />, { url: "/home" });
    await expect.element(page.getByRole("link", { name: /Dropped my pen/ })).toBeVisible();
    expect(page.getByRole("link", { name: /One tip that changed my mornings/ }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Show more" }));
    await expect
      .element(page.getByRole("link", { name: /One tip that changed my mornings/ }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("leaves out the views a short hides, and says when there's nothing", async () => {
    await signUp();
    editShorts<Feed>("feed", (feed, input) =>
      input.topic === "pets"
        ? { items: [], nextPageToken: null }
        : {
            items: feed.items.slice(0, 1).map((short) => ({ ...short, viewCount: null })),
            nextPageToken: null,
          },
    );
    const page = await renderPage(<HomePage />, { url: "/home" });
    const card = page.getByRole("link", { name: FIRST });
    await expect.element(card).toBeVisible();
    await expect.element(card).not.toMatchTextContent(/views/);
    await userEvent.click(page.getByRole("button", { name: "Pets" }));
    await expect.element(page.getByText("No shorts here yet.")).toBeVisible();
  });

  it("says why the feed didn't load", async () => {
    await signUp();
    await commands.failRequests("/rpc/shorts/feed");
    const page = await renderPage(<HomePage />, { url: "/home" });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });

  it("opens a short from a pasted link", async () => {
    await signUp();
    const page = await renderPage(<HomePage />, { url: "/home" });
    const open = page.getByRole("button", { name: "Open" });
    await expect.element(open).toBeDisabled();
    await userEvent.fill(
      page.getByLabelText("Paste a Shorts link"),
      "https://youtu.be/kJQP7kiw5Fk",
    );
    await userEvent.click(open);
    await expect.poll(currentUrl).toBe("/shorts/kJQP7kiw5Fk");
  });

  it("says when a pasted link isn't a short", async () => {
    await signUp();
    const page = await renderPage(<HomePage />, { url: "/home" });
    const input = page.getByLabelText("Paste a Shorts link");
    await userEvent.fill(input, "https://example.com/video");
    await userEvent.click(page.getByRole("button", { name: "Open" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That short isn't on YouTube, or it's private.");
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    expect(currentUrl()).toBe("/home");
  });
});
