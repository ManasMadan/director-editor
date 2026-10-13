import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { SiteHeader } from "@/modules/shell";
import { renderPage } from "../render";
import { signUp } from "../users";

it("doesn't offer the assistant when the AI service is off", async () => {
  const user = await signUp();
  const page = await renderPage(<SiteHeader />, { url: "/dashboard" });
  await userEvent.click(page.getByRole("button", { name: user.name }));
  await expect.element(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  expect(page.getByRole("menuitem", { name: "Assistant" }).query()).toBeNull();
});
