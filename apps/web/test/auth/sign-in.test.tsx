import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SignInPage } from "@/modules/auth";
import { cleanup, currentUrl, renderPage, router } from "../render";
import { auth, enableTwoFactor, newUser, signOut, signUp } from "../users";

async function fillIn(
  page: Awaited<ReturnType<typeof renderPage>>,
  email: string,
  password: string,
) {
  await userEvent.fill(page.getByLabelText("Email"), email);
  await userEvent.fill(page.getByLabelText("Password"), password);
  await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
}

describe("sign in", () => {
  it("signs in with email and password and continues to ?next=", async () => {
    const user = await signUp();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await fillIn(page, user.email, user.password);
    await expect.poll(currentUrl).toBe("/settings");
    expect(router.refreshes).toBe(1);
    expect(await commands.hardNavigations()).toEqual([]);
  });

  it("says when the password is wrong, and checks the form first", async () => {
    const user = await signUp();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
    await expect.element(page.getByText("Enter a valid email address")).toBeVisible();
    await fillIn(page, user.email, "not-the-password");
    await expect.element(page.getByText("That email and password don't match.")).toBeVisible();
    expect(currentUrl()).toBe("/sign-in");
  });

  it("sends an unverified account to verify its email, keeping the query", async () => {
    const user = newUser();
    await auth("/sign-up/email", user);
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/assistant" });
    await fillIn(page, user.email, user.password);
    await expect
      .poll(currentUrl)
      .toBe(`/verify-email?next=%2Fassistant&email=${encodeURIComponent(user.email)}`);
  });

  it("continues on the two-step page when the account has it on", async () => {
    const user = await signUp();
    await enableTwoFactor(user);
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await fillIn(page, user.email, user.password);
    await expect
      .poll(commands.hardNavigations)
      .toEqual([`${window.location.origin}/two-factor?next=/settings`]);
    expect(currentUrl()).toBe("/sign-in?next=/settings");
  });

  it("signs in with a passkey, and says so when the prompt is dismissed", async () => {
    await commands.virtualAuthenticator();
    await signUp();
    const { authClient } = await import("@/lib/auth-client");
    expect((await authClient.passkey.addPasskey()).error).toBeFalsy();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(page.getByRole("button", { name: "Sign in with a passkey" }));
    await expect.poll(currentUrl).toBe("/dashboard");

    // A fresh authenticator has no passkey for this site: the prompt ends without one.
    cleanup();
    await signOut();
    await commands.virtualAuthenticator();
    const again = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(again.getByRole("button", { name: "Sign in with a passkey" }));
    await expect
      .element(again.getByText("The passkey prompt was closed before finishing.", { exact: false }))
      .toBeVisible();
  });

  it("offers Google when it's on, and goes there with ?next= as the way back", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/assistant" });
    await userEvent.click(page.getByRole("button", { name: "Continue with Google" }));
    await expect
      .poll(async () => (await commands.hardNavigations())[0])
      .toMatch(
        /^https:\/\/accounts\.google\.com\/.*client_id=web-tests\.apps\.googleusercontent\.com/,
      );
  });

  it("links to the other auth steps, keeping the query", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await expect
      .element(page.getByRole("link", { name: "Create account" }))
      .toHaveAttribute("href", "/sign-up?next=%2Fsettings");
    await userEvent.click(page.getByRole("link", { name: "Forgot password?" }));
    await expect.poll(currentUrl).toBe("/forgot-password");
  });
});
