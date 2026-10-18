/** The library on an API without Director: it says so, and still checks the session. */
import { expect, it } from "vitest";
import { LibraryPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signOut, signUp } from "../users";

it("says Director isn't set up, and leads to settings", async () => {
  await signUp();
  const page = await renderPage(<LibraryPage />, { url: "/library" });
  await expect.element(page.getByText("Director isn't set up yet.")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Go to settings" }))
    .toHaveAttribute("href", "/settings");
  expect(currentUrl()).toBe("/library");
});

it("sends a member whose session ended to sign in, though Director is off", async () => {
  await signUp();
  await signOut();
  await renderPage(<LibraryPage />, { url: "/library" });
  await expect.poll(currentUrl).toBe("/sign-in?next=%2Flibrary");
});
