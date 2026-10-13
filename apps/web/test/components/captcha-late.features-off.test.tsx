/** Turnstile's script arrives after the form it was loading for is gone. */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { cleanup, renderPage } from "../render";

it("renders no widget for a form that was left", async () => {
  await commands.turnstile("held");
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect
    .poll(() => document.head.querySelector('script[src*="challenges.cloudflare.com"]'))
    .toBeTruthy();
  const box = page.getByTestId("captcha").element() as HTMLElement;
  cleanup();
  await commands.turnstile("fake");
  await expect.poll(() => window.turnstile).toBeTruthy();
  expect(box.dataset.widget).toBeUndefined();
});
