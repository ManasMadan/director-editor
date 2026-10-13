import { expect, it } from "vitest";
import { HomePage } from "@/modules/shorts";
import { renderPage } from "../render";
import { signUp } from "../users";

it("says Director isn't set up, and leads back to the dashboard", async () => {
  await signUp();
  const page = await renderPage(<HomePage />, { url: "/home" });
  await expect
    .element(page.getByText("Director isn't set up in this workspace yet."))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Back to the dashboard" }))
    .toHaveAttribute("href", "/dashboard");
  expect(page.getByRole("navigation", { name: "Main" }).query()).toBeNull();
});
