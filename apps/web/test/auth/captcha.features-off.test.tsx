/** The auth forms with captcha on (this project's API has Turnstile configured). */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ForgotPasswordPage, SignUpPage, VerifyEmailPage } from "@/modules/auth";
import { currentUrl, renderPage } from "../render";
import { auth, newUser, takeOtp } from "../users";

describe("with captcha on", () => {
  it("signs up once the security check has passed", async () => {
    const user = newUser();
    const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
    await expect.element(page.getByTestId("captcha")).toHaveAttribute("data-widget");
    await userEvent.fill(page.getByLabelText("Full name"), user.name);
    await userEvent.fill(page.getByLabelText("Email"), user.email);
    await userEvent.fill(page.getByLabelText("Password"), user.password);
    await userEvent.click(page.getByRole("button", { name: "Create account" }));
    await expect.poll(currentUrl).toBe(`/verify-email?email=${encodeURIComponent(user.email)}`);
    expect(await takeOtp(user.email)).toMatch(/^\d{6}$/);
  });

  it("resends a verification code with a fresh token", async () => {
    const user = newUser();
    await auth("/sign-up/email", user);
    await takeOtp(user.email);
    const page = await renderPage(<VerifyEmailPage />, {
      url: `/verify-email?email=${encodeURIComponent(user.email)}`,
    });
    await expect.element(page.getByRole("button", { name: "Resend code" })).toBeEnabled();
    await userEvent.click(page.getByRole("button", { name: "Resend code" }));
    await expect.element(page.getByText("A new code is on its way.")).toBeVisible();
    expect(await takeOtp(user.email)).toMatch(/^\d{6}$/);
  });

  it("asks for a password reset code", async () => {
    const page = await renderPage(<ForgotPasswordPage />, { url: "/forgot-password" });
    const email = `web-${crypto.randomUUID()}@example.com`;
    await userEvent.fill(page.getByLabelText("Email"), email);
    await userEvent.click(page.getByRole("button", { name: "Send code" }));
    await expect.poll(currentUrl).toBe(`/reset-password?email=${encodeURIComponent(email)}`);
  });

  it("can't be sent before the page knows a security check is needed", async () => {
    const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
    const submit = page.getByRole("button", { name: "Create account" });
    // Still asking the API whether captcha is on: a submit now would be refused.
    expect((submit.element() as HTMLButtonElement).disabled).toBe(true);
    await expect.element(page.getByTestId("captcha")).toHaveAttribute("data-widget");
    await expect.element(submit).toBeEnabled();
  });

  it.each(["expire", "fail"] as const)(
    "holds the form when the token is gone (%s)",
    async (outcome) => {
      const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
      const submit = page.getByRole("button", { name: "Create account" });
      await expect.element(page.getByTestId("captcha")).toHaveAttribute("data-widget");
      await expect.element(submit).toBeEnabled();
      (window.turnstile as unknown as Record<typeof outcome, () => void>)[outcome]();
      await expect.element(submit).toBeDisabled();
    },
  );
});
