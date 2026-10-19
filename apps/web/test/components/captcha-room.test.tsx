/** The captcha widget's room on a form, while the page learns whether captcha is on. */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { renderPage } from "../render";

const box = () => document.querySelector<HTMLElement>('[data-testid="captcha"]');

it("keeps a widget's room while it isn't known whether there will be one", async () => {
  // Unanswered for now: the API retries a 503 before giving up.
  await commands.failRequests("/rpc/system/info", { status: 503 });
  await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.poll(() => box()?.getBoundingClientRect().height).toBe(65);
});

it("gives the room back once captcha is known to be off", async () => {
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.element(page.getByRole("button", { name: "Create account" })).toBeEnabled();
  expect(box()).toBeNull();
});
