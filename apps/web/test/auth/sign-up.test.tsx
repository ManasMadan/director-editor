import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { currentUrl, renderPage } from "../render";
import { newUser, takeOtp } from "../users";

async function fillIn(
  page: Awaited<ReturnType<typeof renderPage>>,
  user: ReturnType<typeof newUser>,
) {
  await userEvent.fill(page.getByLabelText("Full name"), user.name);
  await userEvent.fill(page.getByLabelText("Email"), user.email);
  await userEvent.fill(page.getByLabelText("Password"), user.password);
  await userEvent.click(page.getByRole("button", { name: "Create account" }));
}

describe("sign up", () => {
  it("creates the account, emails a code and continues to verify it", async () => {
    const user = newUser();
    const page = await renderPage(<SignUpPage />, { url: "/sign-up?next=/assistant" });
    await fillIn(page, user);
    await expect
      .poll(currentUrl)
      .toBe(`/verify-email?next=%2Fassistant&email=${encodeURIComponent(user.email)}`);
    expect(await takeOtp(user.email)).toMatch(/^\d{6}$/);
  });

  it("says why the API refused the account, and stays on the page", async () => {
    // Answered as the API refuses a breached password: only production's API checks one
    // (Have I Been Pwned); the API's own suite covers the check against a stand-in.
    await commands.failRequests("/api/auth/sign-up/email", {
      status: 400,
      body: { code: "PASSWORD_COMPROMISED", message: "compromised" },
    });
    const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
    await fillIn(page, newUser());
    await expect
      .element(page.getByText("This password appeared in a data breach. Choose a different one."))
      .toBeVisible();
    expect(currentUrl()).toBe("/sign-up");
  });

  it("links back to sign in", async () => {
    const page = await renderPage(<SignUpPage />, { url: "/sign-up?next=/settings" });
    await expect
      .element(page.getByRole("link", { name: "Sign in" }))
      .toHaveAttribute("href", "/sign-in?next=%2Fsettings");
  });
});
