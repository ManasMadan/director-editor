import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ForgotPasswordPage, ResetPasswordPage } from "@/modules/auth";
import { cleanup, currentUrl, renderPage } from "../render";
import { auth, rateLimit, signOut, signUp, takeOtp } from "../users";

describe("password reset", () => {
  it("emails a code, then sets the new password with it", async () => {
    const user = await signUp();
    await signOut();
    const forgot = await renderPage(<ForgotPasswordPage />, { url: "/forgot-password" });
    await expect
      .element(forgot.getByRole("link", { name: "Back to sign in" }))
      .toHaveAttribute("href", "/sign-in");
    await userEvent.fill(forgot.getByLabelText("Email"), user.email);
    await userEvent.click(forgot.getByRole("button", { name: "Send code" }));
    const resetUrl = `/reset-password?email=${encodeURIComponent(user.email)}`;
    await expect.poll(currentUrl).toBe(resetUrl);
    const otp = await takeOtp(user.email);

    cleanup();
    const reset = await renderPage(<ResetPasswordPage />, { url: resetUrl });
    const password = `pw-${crypto.randomUUID()}`;
    await userEvent.fill(
      reset.getByLabelText("Verification code"),
      otp === "000000" ? "111111" : "000000",
    );
    await userEvent.fill(reset.getByLabelText("New password"), password);
    await userEvent.click(reset.getByRole("button", { name: "Continue" }));
    await expect.element(reset.getByText("That code is wrong or has expired.")).toBeVisible();

    await userEvent.fill(reset.getByLabelText("Verification code"), otp);
    await userEvent.click(reset.getByRole("button", { name: "Continue" }));
    await expect
      .element(reset.getByText("Password updated. Sign in with your new password."))
      .toBeVisible();
    await expect.poll(currentUrl).toBe("/sign-in");
    await expect(auth("/sign-in/email", { email: user.email, password })).resolves.toBeTruthy();
  });

  it("sends visitors without an address back to the first step", async () => {
    await renderPage(<ResetPasswordPage />, { url: "/reset-password" });
    await expect.poll(currentUrl).toBe("/forgot-password");
  });

  it("says when too many codes were asked for", async () => {
    const email = `web-${crypto.randomUUID()}@example.com`;
    await rateLimit("/email-otp/request-password-reset", { email });
    const page = await renderPage(<ForgotPasswordPage />, { url: "/forgot-password" });
    await userEvent.fill(page.getByLabelText("Email"), email);
    await userEvent.click(page.getByRole("button", { name: "Send code" }));
    await expect
      .element(page.getByText("Too many attempts. Wait a minute and try again."))
      .toBeVisible();
    expect(currentUrl()).toBe("/forgot-password");
  });
});
