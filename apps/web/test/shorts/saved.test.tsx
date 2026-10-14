import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SavedPage } from "@/modules/shorts";
import { renderPage } from "../render";
import { api, signUp } from "../users";

describe("the shorts the member kept", () => {
  it("lists the saved ones, and the liked ones on their tab", async () => {
    await signUp();
    await api.shorts.react({ videoId: "kJQP7kiw5Fk", kind: "save", on: true });
    await api.shorts.react({ videoId: "9bZkp7q19f0", kind: "like", on: true });
    const page = await renderPage(<SavedPage />, { url: "/saved" });
    await expect
      .element(page.getByRole("link", { name: /^Dropped my pen/ }))
      .toHaveAttribute("href", "/shorts/kJQP7kiw5Fk");
    expect(
      page.getByRole("link", { name: /^One tip that changed my mornings/ }).query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "You" }))
      .toHaveAttribute("aria-current", "page");
    await userEvent.click(page.getByRole("tab", { name: "Liked" }));
    await expect
      .element(page.getByRole("link", { name: /^One tip that changed my mornings/ }))
      .toHaveAttribute("href", "/shorts/9bZkp7q19f0");
  });

  it("says when nothing is kept yet", async () => {
    await signUp();
    const page = await renderPage(<SavedPage />, { url: "/saved" });
    await expect
      .element(page.getByText("Nothing here yet. Like or save a short from the feed."))
      .toBeVisible();
  });

  it("says why the list didn't load", async () => {
    await signUp();
    await commands.failRequests("/rpc/shorts/saved");
    const page = await renderPage(<SavedPage />, { url: "/saved" });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });
});
