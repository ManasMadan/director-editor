import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { TwoFactorPage } from "@/modules/auth";
import { currentUrl, renderPage } from "../render";
import { auth, enableTwoFactor, signOut, signUp } from "../users";

/** Signs in with the password, which stops at the second step. */
async function firstStep() {
  const user = await signUp();
  const factor = await enableTwoFactor(user);
  await signOut();
  const answer = await auth<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
    email: user.email,
    password: user.password,
  });
  expect(answer.twoFactorRedirect).toBe(true);
  return factor;
}

describe("the second sign-in step", () => {
  it("rejects a wrong authenticator code and accepts the right one", async () => {
    const { secret } = await firstStep();
    const page = await renderPage(<TwoFactorPage />, { url: "/two-factor?next=/settings" });
    const right = await commands.totp(secret);
    await userEvent.fill(
      page.getByLabelText("Verification code"),
      right === "123456" ? "654321" : "123456",
    );
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("That code is wrong.")).toBeVisible();

    await userEvent.click(page.getByRole("checkbox", { name: "Trust this device for 30 days" }));
    await userEvent.fill(page.getByLabelText("Verification code"), await commands.totp(secret));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.poll(currentUrl).toBe("/settings");
  });

  it("takes a backup code instead", async () => {
    const { backupCodes } = await firstStep();
    const page = await renderPage(<TwoFactorPage />, { url: "/two-factor" });
    await userEvent.click(page.getByRole("button", { name: "Use a backup code instead" }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.element(page.getByText("Required")).toBeVisible();
    await userEvent.fill(page.getByLabelText("Backup code"), "not-a-backup-code");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByText("That backup code is wrong or was already used."))
      .toBeVisible();
    await userEvent.fill(page.getByLabelText("Backup code"), backupCodes[0] as string);
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect.poll(currentUrl).toBe("/dashboard");
  });

  it("switches back to the authenticator", async () => {
    const page = await renderPage(<TwoFactorPage />, { url: "/two-factor" });
    await userEvent.click(page.getByRole("button", { name: "Use a backup code instead" }));
    await userEvent.click(page.getByRole("button", { name: "Use your authenticator app" }));
    await expect.element(page.getByLabelText("Verification code")).toBeVisible();
  });
});
