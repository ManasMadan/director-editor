import { expect, it } from "vitest";
import { HomePage } from "@/modules/shorts";
import { renderPage } from "../render";
import { signUp } from "../users";

it("says Director isn't set up, and leads to settings", async () => {
  await signUp();
  const page = await renderPage(<HomePage />, { url: "/library" });
  await expect.element(page.getByText("Director isn't set up yet.")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Go to settings" }))
    .toHaveAttribute("href", "/settings");
  expect(page.getByRole("navigation", { name: "Main" }).query()).toBeNull();
});
