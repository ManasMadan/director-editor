import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { VerifyEmailPage } from "@/modules/auth";
import { currentUrl, renderPage } from "../render";
import { auth, newUser, rateLimit, takeOtp } from "../users";

const verifyUrl = (email: string) =>
  `/verify-email?next=/settings&email=${encodeURIComponent(email)}`;

describe("verify email", () => {
  it("sends visitors without an address to sign in", async () => {
    await renderPage(<VerifyEmailPage />, { url: "/verify-email?email=not-an-email" });
    await expect.poll(currentUrl).toBe("/sign-in");
  });

  it("rejects a wrong code, resends one, and signs in with it", async () => {
    const user = newUser();
    await auth("/sign-up/email", user);
    const first = await takeOtp(user.email);
    const page = await renderPage(<VerifyEmailPage />, { url: verifyUrl(user.email) });
    await expect.element(page.getByText(`sent to ${user.email}`, { exact: false })).toBeVisible();

    await userEvent.fill(
      page.getByLabelText("Verification code"),
      first === "000000" ? "111111" : "000000",
    );
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("That code is wrong or has expired.")).toBeVisible();
    await expect.element(page.getByLabelText("Verification code")).toHaveValue("");

    await userEvent.click(page.getByRole("button", { name: "Resend code" }));
    await expect.element(page.getByText("A new code is on its way.")).toBeVisible();
    await userEvent.fill(page.getByLabelText("Verification code"), await takeOtp(user.email));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("Email verified. Welcome!")).toBeVisible();
    await expect.poll(currentUrl).toBe("/settings");
  });

  it("says when a code can't be resent", async () => {
    const user = newUser();
    await auth("/sign-up/email", user);
    await rateLimit("/email-otp/send-verification-otp", {
      email: user.email,
      type: "email-verification",
    });
    const page = await renderPage(<VerifyEmailPage />, { url: verifyUrl(user.email) });
    await userEvent.click(page.getByRole("button", { name: "Resend code" }));
    await expect
      .element(page.getByText("Too many attempts. Wait a minute and try again."))
      .toBeVisible();
  });
});
