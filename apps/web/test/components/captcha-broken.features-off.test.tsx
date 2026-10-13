/** Turnstile's script loads but doesn't set up the widget (a broken or tampered copy). */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { cleanup, renderPage } from "../render";

it("says the security check couldn't load", async () => {
  await commands.turnstile("empty");
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect
    .element(page.getByText("The security check couldn't load.", { exact: false }))
    .toBeVisible();
});

it("stays failed until the page is reloaded", async () => {
  // The broken script ran; loading it again wouldn't change what it did.
  cleanup();
  await commands.turnstile("fake");
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect
    .element(page.getByText("The security check couldn't load.", { exact: false }))
    .toBeVisible();
});
