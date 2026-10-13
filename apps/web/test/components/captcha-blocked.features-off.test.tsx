/** Turnstile's script can't load (an extension blocks it, or the network is down). */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { cleanup, renderPage } from "../render";

const FAILED = "The security check couldn't load.";
const requested = () =>
  expect.poll(() => document.head.querySelector('script[src*="challenges.cloudflare.com"]'));

it("says so instead of leaving the form stuck, and tries again next time", async () => {
  await commands.turnstile("held");
  // Left while the script was still loading: nothing is shown for it when it fails.
  await renderPage(<SignUpPage />, { url: "/sign-up" });
  await requested().toBeTruthy();
  cleanup();
  await commands.turnstile("blocked");
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.element(page.getByText(FAILED, { exact: false })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create account" })).toBeDisabled();

  cleanup();
  await commands.turnstile("fake");
  const again = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.element(again.getByRole("button", { name: "Create account" })).toBeEnabled();
  expect(again.getByText(FAILED, { exact: false }).query()).toBeNull();
});
